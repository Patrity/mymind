import { connectionDeps, type Connection } from './connections'
import { mentionsInvalidGrant, runWithRefreshProbe, type RefreshProbe } from './refresh-probe'

export class GoogleReconnectError extends Error {
  constructor(public connection: Connection, reason: string) {
    super(`Google account "${connection.label}" (${connection.email}) needs reconnecting in Settings → Connections: ${reason}`)
    this.name = 'GoogleReconnectError'
  }
}

export interface TokenDeps {
  getAccessToken?: (a: { providerId: 'google', accountId: string, userId: string }) => Promise<{ accessToken: string }>
}

export interface RefreshDeps {
  refreshToken?: (a: { providerId: 'google', accountId: string, userId: string }) => Promise<{ accessToken: string }>
}

const RECONNECT_REASON = 'Google access was revoked or expired'

/**
 * A valid access token for `c`, refreshed by better-auth when expired. A revoked/expired refresh
 * token (`invalid_grant`) marks the connection needs_reconnect and throws GoogleReconnectError;
 * every other failure propagates unchanged (a network blip must not force a re-link).
 */
export async function googleToken(c: Connection, deps: TokenDeps = {}): Promise<string> {
  const get = deps.getAccessToken ?? connectionDeps.getAccessToken
  const probe: RefreshProbe = { invalidGrant: false }
  try {
    const { accessToken } = await runWithRefreshProbe(probe, () =>
      get({ providerId: 'google', accountId: c.googleSub, userId: c.userId }))
    return accessToken
  } catch (err) {
    if (probe.invalidGrant || mentionsInvalidGrant(err)) {
      await connectionDeps.markReconnect(c.id, RECONNECT_REASON)
      throw new GoogleReconnectError(c, RECONNECT_REASON)
    }
    throw err
  }
}

/**
 * Forces a fresh access token for `c` through better-auth's unconditional `/refresh-token` path
 * (unlike `googleToken`'s `/get-access-token`, which only refreshes within 5s of the STORED
 * expiry — useless when a 401 means that stored judgment was wrong: expiry skew between Google's
 * clock and ours, an access token Google invalidated early, or a transient revocation). Runs
 * behind the same invalid_grant probe as googleToken: a revoked refresh token marks
 * needs_reconnect and throws GoogleReconnectError; any other failure (network blip, Google 5xx)
 * propagates unchanged so a flaky refresh never forces a re-link.
 */
export async function forceRefresh(c: Connection, deps: RefreshDeps = {}): Promise<string> {
  // better-auth's /refresh-token response types accessToken as possibly undefined (its generic
  // OAuth2Tokens shape), but a successful refresh always returns one — guard rather than cast.
  const refresh = deps.refreshToken ?? (async (a: { providerId: 'google', accountId: string, userId: string }) => {
    const result = await useAuth().api.refreshToken({ body: a })
    if (!result.accessToken) throw new Error('refresh-token response had no accessToken')
    return { accessToken: result.accessToken }
  })
  const probe: RefreshProbe = { invalidGrant: false }
  try {
    const { accessToken } = await runWithRefreshProbe(probe, () =>
      refresh({ providerId: 'google', accountId: c.googleSub, userId: c.userId }))
    return accessToken
  } catch (err) {
    if (probe.invalidGrant || mentionsInvalidGrant(err)) {
      await connectionDeps.markReconnect(c.id, RECONNECT_REASON)
      throw new GoogleReconnectError(c, RECONNECT_REASON)
    }
    throw err
  }
}
