// server/lib/google/client.ts
// A thin REST client over fetch for Google APIs: Bearer auth, query-string building (array
// values repeat the key), one retry for a 401 (via a fresh token) and for 429/503 (after a
// ~1s sleep), and a 403 for a missing scope → GoogleScopeError (that ONE service; the account
// stays usable for the others — fix wave M2). Uses `deps.fetch ?? globalThis.fetch`
// directly (never `$fetch`) so tests can fully control the transport via fakeFetch.

import { touchConnection, type Connection } from './connections'
import { googleToken, forceRefresh, GoogleReconnectError } from './token'

export interface GoogleDeps {
  fetch?: typeof globalThis.fetch
  token?: (c: Connection) => Promise<string>
  /** Forces a fresh token on a 401 (see token.ts's forceRefresh) — not the same seam as `token`,
   *  which may just hand back the same stored token better-auth saw no reason to refresh. */
  refresh?: (c: Connection) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

type QueryValue = string | number | boolean | string[] | undefined
export type GoogleQuery = Record<string, QueryValue>

export class GoogleApiError extends Error {
  status: number
  reason?: string
  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.name = 'GoogleApiError'
    this.status = status
    this.reason = reason
  }
}

/** A 403 because the token lacks THIS API's scope (an unticked box under granular consent).
 *  Deliberately NOT a reconnect of the whole account (fix wave M2): the other services keep
 *  working, and the tool reports which one wasn't granted. */
export class GoogleScopeError extends Error {
  constructor(public connection: Connection, public service: string) {
    super(`Google account "${connection.label}" did not grant ${service} access`)
    this.name = 'GoogleScopeError'
  }
}

const RATE_LIMIT_SLEEP_MS = 1000

/** The user-facing name of the Google API a URL belongs to. */
export function serviceOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'gmail.googleapis.com' || u.pathname.startsWith('/gmail/')) return 'Gmail'
    if (u.hostname === 'people.googleapis.com') return 'Contacts'
    if (u.pathname.startsWith('/calendar/')) return 'Calendar'
  } catch { /* fall through */ }
  return 'this Google service'
}

function buildUrl(url: string, query?: GoogleQuery): string {
  if (!query) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) u.searchParams.append(key, String(item))
    } else {
      u.searchParams.append(key, String(value))
    }
  }
  return u.toString()
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** Google error bodies: `{ error: { errors: [{ reason }] } }` (v1/discovery APIs) or
 *  `{ error: { status: 'PERMISSION_DENIED' } }` (gRPC-style, e.g. People API). */
function errorReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const err = (body as { error?: unknown }).error
  if (!err || typeof err !== 'object') return undefined
  const errors = (err as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === 'object') {
    const reason = (errors[0] as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  }
  const status = (err as { status?: unknown }).status
  if (typeof status === 'string') return status
  return undefined
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object') {
      const message = (err as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
  }
  return `HTTP ${status}`
}

/** Only a MISSING SCOPE counts (fix wave M2): `errors[].reason: insufficientPermissions`
 *  (v1/discovery APIs) or `details[].reason: ACCESS_TOKEN_SCOPE_INSUFFICIENT` (gRPC-style, e.g.
 *  People). A bare `status: PERMISSION_DENIED` is NOT one — People reports API-not-enabled
 *  (SERVICE_DISABLED) and Workspace policy refusals the same way, and reconnecting fixes
 *  neither; those stay a plain GoogleApiError(403). */
function isScopeInsufficient(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const err = (body as { error?: unknown }).error
  if (!err || typeof err !== 'object') return false
  const reasons: unknown[] = []
  for (const key of ['errors', 'details'] as const) {
    const list = (err as Record<string, unknown>)[key]
    if (Array.isArray(list)) for (const item of list) if (item && typeof item === 'object') reasons.push((item as { reason?: unknown }).reason)
  }
  return reasons.some(r => r === 'insufficientPermissions' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
}

export function google(c: Connection, deps: GoogleDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch
  const getToken = deps.token ?? ((conn: Connection) => googleToken(conn))
  const forceTokenRefresh = deps.refresh ?? ((conn: Connection) => forceRefresh(conn))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  async function call(method: string, url: string, opts: { query?: GoogleQuery; body?: unknown } = {}): Promise<unknown> {
    const fullUrl = buildUrl(url, opts.query)
    let token = await getToken(c)
    let retried401 = false
    let retriedRateLimit = false

    for (;;) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` }
      let payload: string | undefined
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(opts.body)
      }

      const res = await doFetch(fullUrl, { method, headers, body: payload })

      if (res.status === 401) {
        if (retried401) {
          const body = await safeJson(res)
          throw new GoogleApiError(401, errorMessage(body, 401), errorReason(body))
        }
        retried401 = true
        // Force a refresh through the unconditional /refresh-token path (not `getToken`, which
        // may just hand back the same stored token better-auth saw no reason to touch). A
        // revoked refresh token surfaces as GoogleReconnectError from forceRefresh itself — let
        // it propagate; any other failure (network blip) also propagates unchanged.
        token = await forceTokenRefresh(c)
        continue
      }

      if (res.status === 429 || res.status === 503) {
        if (retriedRateLimit) {
          const body = await safeJson(res)
          throw new GoogleApiError(res.status, errorMessage(body, res.status), errorReason(body))
        }
        retriedRateLimit = true
        await sleep(RATE_LIMIT_SLEEP_MS)
        continue
      }

      if (res.status === 403) {
        const body = await safeJson(res)
        if (isScopeInsufficient(body)) throw new GoogleScopeError(c, serviceOf(url))
        throw new GoogleApiError(403, errorMessage(body, 403), errorReason(body))
      }

      if (!res.ok) {
        const body = await safeJson(res)
        throw new GoogleApiError(res.status, errorMessage(body, res.status), errorReason(body))
      }

      // Fire-and-forget: a bookkeeping UPDATE (or a DB hiccup touching it) must never turn an
      // already-successful Google response into a thrown error, and must never add latency
      // (Gmail search makes one of these per message).
      touchConnection(c.id).catch(err => console.warn(`[google] touchConnection failed for ${c.id}`, err))
      if (res.status === 204) return undefined
      return await safeJson(res)
    }
  }

  return {
    get<T>(url: string, query?: GoogleQuery): Promise<T> {
      return call('GET', url, { query }) as Promise<T>
    },
    post<T>(url: string, body?: unknown, query?: GoogleQuery): Promise<T> {
      return call('POST', url, { query, body }) as Promise<T>
    },
    put<T>(url: string, body?: unknown, query?: GoogleQuery): Promise<T> {
      return call('PUT', url, { query, body }) as Promise<T>
    },
    patch<T>(url: string, body?: unknown, query?: GoogleQuery): Promise<T> {
      return call('PATCH', url, { query, body }) as Promise<T>
    },
    async del(url: string, query?: GoogleQuery): Promise<void> {
      await call('DELETE', url, { query })
    }
  }
}

/** The §6 user-facing strings: never leak raw HTTP status/JSON to Tony. */
export function googleErrorMessage(err: unknown, label: string): string {
  if (err instanceof GoogleReconnectError) {
    return `the ${label} Google account needs reconnecting in Settings → Connections`
  }
  if (err instanceof GoogleScopeError) {
    return `your ${label} account didn't grant ${err.service} access — reconnect it in Settings → Connections and allow it`
  }
  if (err instanceof GoogleApiError) {
    if (err.status === 404) return 'that thread/event no longer exists'
    return `Google error ${err.status}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
