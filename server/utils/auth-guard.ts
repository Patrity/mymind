import type { H3Event } from 'h3'

export interface ClientContext {
  type?: 'session' | 'api-token' | 'oauth'
  userId?: string
  tokenId?: string
}

/** Pure predicate: true only for an authenticated web-session client. */
export function isSessionClient(client: ClientContext | undefined): boolean {
  return client?.type === 'session'
}

/**
 * Throw 403 unless the caller is a web session. Use on sensitive endpoints
 * (token management) so a leaked machine token can't escalate.
 */
export function requireSession(event: H3Event): void {
  const client = event.context.client as ClientContext | undefined
  if (!isSessionClient(client)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden: session required' })
  }
}
