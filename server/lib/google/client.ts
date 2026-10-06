// server/lib/google/client.ts
// A thin REST client over fetch for Google APIs: Bearer auth, query-string building (array
// values repeat the key), one retry for a 401 (via a fresh token) and for 429/503 (after a
// ~1s sleep), and 403 insufficientPermissions → reconnect. Uses `deps.fetch ?? globalThis.fetch`
// directly (never `$fetch`) so tests can fully control the transport via fakeFetch.

import { markReconnect, touchConnection, type Connection } from './connections'
import { googleToken, GoogleReconnectError } from './token'

export interface GoogleDeps {
  fetch?: typeof globalThis.fetch
  token?: (c: Connection) => Promise<string>
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

const RATE_LIMIT_SLEEP_MS = 1000
const SAME_TOKEN_REASON = 'Google rejected the stored access token and a refresh did not change it'
const INSUFFICIENT_PERMISSIONS_REASON = 'Google reported insufficient permissions for this scope'

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

function isInsufficientPermissions(reason: string | undefined): boolean {
  return reason === 'insufficientPermissions' || reason === 'PERMISSION_DENIED'
}

export function google(c: Connection, deps: GoogleDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch
  const getToken = deps.token ?? ((conn: Connection) => googleToken(conn))
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
        const newToken = await getToken(c)
        if (newToken === token) {
          await markReconnect(c.id, SAME_TOKEN_REASON)
          throw new GoogleReconnectError(c, SAME_TOKEN_REASON)
        }
        token = newToken
        retried401 = true
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
        const reason = errorReason(body)
        if (isInsufficientPermissions(reason)) {
          await markReconnect(c.id, INSUFFICIENT_PERMISSIONS_REASON)
          throw new GoogleReconnectError(c, INSUFFICIENT_PERMISSIONS_REASON)
        }
        throw new GoogleApiError(403, errorMessage(body, 403), reason)
      }

      if (!res.ok) {
        const body = await safeJson(res)
        throw new GoogleApiError(res.status, errorMessage(body, res.status), errorReason(body))
      }

      await touchConnection(c.id)
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
  if (err instanceof GoogleApiError) {
    if (err.status === 404) return 'that thread/event no longer exists'
    return `Google error ${err.status}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
