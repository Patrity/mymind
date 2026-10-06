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
