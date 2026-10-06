// Cycle 79: GET /api/connections — a linked Google account as Settings → Connections sees it.
// Tokens never appear here.
export interface ConnectionDTO {
  id: string
  provider: 'google'
  label: string
  email: string
  status: 'ok' | 'needs_reconnect'
  lastError: string | null
  lastUsedAt: string | null
  /** Granted OAuth scopes (account.scope split on comma/space). */
  scopes: string[]
}

export interface ConnectionsResponse {
  /** NUXT_GOOGLE_CLIENT_ID + NUXT_GOOGLE_CLIENT_SECRET are both set on the server. */
  configured: boolean
  connections: ConnectionDTO[]
}
