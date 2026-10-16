// Cycle 87 (spec §5): short-lived path tokens for private artifacts. The sandboxed page is an opaque
// origin, so its subresource requests don't carry the session cookie; the token in the path does.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { coreConfig } from '../../config'

export const ARTIFACT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000

function key(secret: string | undefined): Buffer {
  const s = secret ?? coreConfig().betterAuthSecret
  if (!s) throw new Error('BETTER_AUTH_SECRET is not set')
  return createHmac('sha256', s).update('artifact-view:v1').digest()
}
const mac = (k: Buffer, body: string) => createHmac('sha256', k).update(body).digest('base64url')

export function signViewToken(artifactId: string, o: { now?: number; secret?: string } = {}): string {
  const k = key(o.secret)
  const body = Buffer.from(`${artifactId}.${(o.now ?? Date.now()) + ARTIFACT_TOKEN_TTL_MS}`).toString('base64url')
  return `${body}.${mac(k, body)}`
}

export function verifyViewToken(token: string, artifactId: string, o: { now?: number; secret?: string } = {}): 'ok' | 'expired' | 'invalid' {
  const k = key(o.secret)
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return 'invalid'
  const want = Buffer.from(mac(k, parts[0]))
  const got = Buffer.from(parts[1])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid'
  const decoded = Buffer.from(parts[0], 'base64url').toString()
  const dot = decoded.lastIndexOf('.')
  if (decoded.slice(0, dot) !== artifactId) return 'invalid'
  const exp = Number(decoded.slice(dot + 1))
  if (!Number.isFinite(exp)) return 'invalid'
  return (o.now ?? Date.now()) > exp ? 'expired' : 'ok'
}
