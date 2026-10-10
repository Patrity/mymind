import { AsyncLocalStorage } from 'node:async_hooks'
import { refreshAccessToken } from 'better-auth/oauth2'

/**
 * better-auth 1.6.13's getAccessToken wraps the provider refresh in a try whose catch DISCARDS the
 * cause and throws a generic `FAILED_TO_GET_ACCESS_TOKEN` — so a revoked refresh token
 * (`invalid_grant`) is indistinguishable from a network blip by the time it reaches us. This probe
 * recovers the signal: googleToken() runs getAccessToken inside `runWithRefreshProbe`, and the
 * provider's `refreshAccessToken` override (below) flags the probe when Google says invalid_grant.
 */
export interface RefreshProbe { invalidGrant: boolean }

const probeStore = new AsyncLocalStorage<RefreshProbe>()

export function runWithRefreshProbe<T>(probe: RefreshProbe, fn: () => Promise<T>): Promise<T> {
  return probeStore.run(probe, fn)
}

export function mentionsInvalidGrant(err: unknown): boolean {
  if (!err) return false
  try {
    const e = err as { message?: unknown, body?: unknown, error?: unknown, cause?: unknown }
    const text = [e.message, e.error, safeJson(e.body), safeJson(err)].filter(Boolean).join(' ')
    if (text.includes('invalid_grant')) return true
    return e.cause !== undefined && e.cause !== err ? mentionsInvalidGrant(e.cause) : false
  } catch {
    return false
  }
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return '' }
}

/** Same request better-auth's built-in Google refresh makes, plus the invalid_grant flag. */
export function googleRefreshAccessToken(opts: { clientId: string, clientSecret: string }) {
  return async (refreshToken: string) => {
    try {
      return await refreshAccessToken({
        refreshToken,
        options: { clientId: opts.clientId, clientSecret: opts.clientSecret },
        tokenEndpoint: 'https://oauth2.googleapis.com/token'
      })
    } catch (err) {
      const probe = probeStore.getStore()
      if (probe && mentionsInvalidGrant(err)) probe.invalidGrant = true
      throw err
    }
  }
}
