import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { account, connections } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'

/** A linked Google account as the tools see it. `accountId` is the better-auth `account` row id
 *  (connections.account_id); `googleSub` is that row's `account_id` (the Google subject). */
export interface Connection {
  id: string
  accountId: string
  userId: string
  googleSub: string
  provider: 'google'
  label: string
  email: string
  status: 'ok' | 'needs_reconnect'
  lastError: string | null
}

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * Test seam (channelToolDeps pattern). `markReconnect` is what token.ts calls on invalid_grant;
 * `fetch` + `getAccessToken` back the no-idToken email lookup. The account hook receives the
 * access token ENCRYPTED (better-auth encrypts before the write), so the fallback asks
 * better-auth for the decrypted token instead of using `acc.accessToken` directly.
 */
export const connectionDeps = {
  markReconnect: (connectionId: string, reason: string) => markReconnect(connectionId, reason),
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  getAccessToken: async (b: { providerId: 'google', accountId: string, userId: string }): Promise<{ accessToken: string }> =>
    useAuth().api.getAccessToken({ body: b })
}

/** 'tony@costanzoclan.com' → 'costanzoclan'; 'x@gmail.com' → 'gmail'; 'a@mail.example.com' →
 *  'example'. Collisions with `taken` get '-2', '-3', … */
export function defaultLabel(email: string, taken: Set<string> = new Set()): string {
  const domain = (email.split('@')[1] ?? email).toLowerCase().trim()
  const parts = domain.split('.').filter(Boolean)
  const base = (parts.length >= 2 ? parts[parts.length - 2]! : parts[0] ?? 'google')
    .replace(/[^a-z0-9-]/g, '') || 'google'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof claims.email === 'string' && claims.email ? claims.email : null
  } catch {
    return null
  }
}

async function emailFromUserinfo(acc: { accountId: string }, userId: string): Promise<string | null> {
  const { accessToken } = await connectionDeps.getAccessToken({ providerId: 'google', accountId: acc.accountId, userId })
  const res = await connectionDeps.fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const body = await res.json() as { email?: unknown }
  return typeof body.email === 'string' && body.email ? body.email : null
}

const selectConnection = {
  id: connections.id,
  accountId: connections.accountId,
  userId: account.userId,
  googleSub: account.accountId,
  provider: connections.provider,
  label: connections.label,
  email: connections.email,
  status: connections.status,
  lastError: connections.lastError
}

export async function listConnections(opts: { status?: 'ok' } = {}): Promise<Connection[]> {
  const rows = await useDb().select(selectConnection)
    .from(connections)
    .innerJoin(account, eq(account.id, connections.accountId))
    .where(opts.status ? eq(connections.status, opts.status) : undefined)
    .orderBy(asc(connections.label))
  return rows as Connection[]
}

/**
 * Called from better-auth's account create/update hooks. Ignores non-Google accounts. Creates the
 * connection on first link; on a re-link / token write it resets status to 'ok' (the reconnect
 * path) and refreshes the email, keeping the label Tony may have renamed.
 */
export async function upsertConnectionForAccount(acc: {
  id: string
  providerId: string
  accountId: string
  userId?: string | null
  idToken?: string | null
  accessToken?: string | null
}): Promise<void> {
  if (acc.providerId !== 'google') return
  const db = useDb()

  let email = emailFromIdToken(acc.idToken)
  if (!email) {
    const userId = acc.userId ?? (await db.select({ userId: account.userId }).from(account).where(eq(account.id, acc.id)))[0]?.userId
    if (userId) email = await emailFromUserinfo(acc, userId)
  }
  if (!email) throw new Error(`could not determine the Google email for account ${acc.id}`)

  const takenRows = await db.select({ label: connections.label }).from(connections)
    .where(and(eq(connections.provider, 'google'), ne(connections.accountId, acc.id)))
  const label = defaultLabel(email, new Set(takenRows.map(r => r.label)))

  const [row] = await db.insert(connections)
    .values({ accountId: acc.id, provider: 'google', label, email })
    .onConflictDoUpdate({
      target: connections.accountId,
      set: { status: 'ok', lastError: null, email: sql`excluded.email`, updatedAt: sql`now()` }
    })
    .returning({ id: connections.id })
  if (row) publishChange({ resource: 'connection', action: 'updated', id: row.id })
}

export async function markReconnect(connectionId: string, reason: string): Promise<void> {
  await useDb().update(connections)
    .set({ status: 'needs_reconnect', lastError: reason, updatedAt: sql`now()` })
    .where(eq(connections.id, connectionId))
  publishChange({ resource: 'connection', action: 'updated', id: connectionId })
}

export async function touchConnection(connectionId: string): Promise<void> {
  await useDb().update(connections)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(connections.id, connectionId))
}
