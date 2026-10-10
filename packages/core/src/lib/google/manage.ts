// Cycle 79, Task 6: the Settings → Connections API's data layer (list DTOs, rename, disconnect).
// Routes under server/api/connections/** are thin wrappers that add requireSession.
import { and, asc, eq, ne } from 'drizzle-orm'
import { decryptOAuthToken } from 'better-auth/oauth2'
import { useDb } from '../../db'
import { account, connections } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { useAuth } from '../auth'
import type { ConnectionDTO } from '../../shared/types/connection'

export type { ConnectionDTO }

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/

/** Test seam: `fetch` is the ONLY path to Google here (tests never reach Google); `decrypt` turns
 *  a stored (encrypted-at-rest) OAuth token back into the plaintext Google issued. */
export const connectionsApiDeps = {
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  // The concrete auth's $context is the generic AuthContext narrowed to our options; the helper
  // only reads options.account.encryptOAuthTokens + secretConfig.
  decrypt: async (token: string): Promise<string> =>
    decryptOAuthToken(token, (await useAuth().$context) as unknown as Parameters<typeof decryptOAuthToken>[1])
}

export class ConnectionError extends Error {
  constructor(public statusCode: 400 | 404 | 409, message: string) { super(message) }
}

/** better-auth stores granted scopes comma-joined; tolerate spaces too. */
export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

export async function listConnectionDTOs(): Promise<ConnectionDTO[]> {
  const rows = await useDb().select({
    id: connections.id,
    provider: connections.provider,
    label: connections.label,
    email: connections.email,
    status: connections.status,
    lastError: connections.lastError,
    lastUsedAt: connections.lastUsedAt,
    scope: account.scope
  }).from(connections)
    .innerJoin(account, eq(account.id, connections.accountId))
    .orderBy(asc(connections.label))
  return rows.map(({ scope, lastUsedAt, ...r }) => ({
    ...r,
    provider: r.provider as 'google',
    lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
    scopes: parseScopes(scope)
  }))
}

export async function renameConnection(id: string, rawLabel: unknown): Promise<ConnectionDTO> {
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : ''
  if (label.length < 1 || label.length > 32 || !LABEL_RE.test(label)) {
    throw new ConnectionError(400, 'Label must be 1–32 characters: lowercase letters, digits and hyphens, not starting with a hyphen.')
  }
  const db = useDb()
  const [current] = await db.select({ provider: connections.provider }).from(connections).where(eq(connections.id, id))
  if (!current) throw new ConnectionError(404, 'Connection not found')
  const clash = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.provider, current.provider), eq(connections.label, label), ne(connections.id, id)))
  if (clash.length) throw new ConnectionError(409, `Another ${current.provider} connection is already labelled "${label}".`)
  try {
    await db.update(connections).set({ label, updatedAt: new Date() }).where(eq(connections.id, id))
  } catch (err) {
    // Race with a concurrent rename: the unique (provider, label) index is the real guard.
    if ((err as { code?: string, cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new ConnectionError(409, `Another ${current.provider} connection is already labelled "${label}".`)
    }
    throw err
  }
  publishChange({ resource: 'connection', action: 'updated', id })
  const dto = (await listConnectionDTOs()).find(c => c.id === id)
  if (!dto) throw new ConnectionError(404, 'Connection not found')
  return dto
}

/** Revoke at Google (best effort, logged), then delete the better-auth `account` row; the FK
 *  cascade removes the connection. Only a providerId='google' account whose id matches this
 *  connection's account_id is ever deleted — never the user's credential account. */
export async function deleteConnection(id: string): Promise<{ revoked: boolean }> {
  const db = useDb()
  const [row] = await db.select({
    accountId: connections.accountId,
    refreshToken: account.refreshToken,
    accessToken: account.accessToken
  }).from(connections)
    .innerJoin(account, and(eq(account.id, connections.accountId), eq(account.providerId, 'google')))
    .where(eq(connections.id, id))
  if (!row) throw new ConnectionError(404, 'Connection not found')

  let revoked = false
  const stored = row.refreshToken ?? row.accessToken
  if (stored) {
    try {
      const token = await connectionsApiDeps.decrypt(stored)
      // The token travels in the form body, never the URL (fix wave M3): URLs end up in proxy
      // and client logs; Google's revoke endpoint accepts `token=` as a form field.
      const res = await connectionsApiDeps.fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString()
      })
      revoked = res.ok
      if (!res.ok) console.warn(`[connections] Google revoke for ${id} returned ${res.status}; deleting locally anyway`)
    } catch (err) {
      console.warn(`[connections] Google revoke for ${id} failed; deleting locally anyway`, (err as Error).message)
    }
  }

  await db.delete(account).where(and(eq(account.id, row.accountId), eq(account.providerId, 'google')))
  publishChange({ resource: 'connection', action: 'deleted', id })
  return { revoked }
}
