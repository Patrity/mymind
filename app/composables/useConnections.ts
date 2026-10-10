import { useQuery } from '@tanstack/vue-query'
import type { ConnectionDTO, ConnectionsResponse } from '@mymind/core/shared/types/connection'

export type { ConnectionDTO, ConnectionsResponse }

/** Cycle 79: linked Google accounts. Key ['connection','list'] is what live-dispatch invalidates
 *  on every `connection` event (link, reconnect, rename, needs_reconnect, disconnect). Shared by
 *  Settings → Connections and the nav chip. */
export function useConnectionsList() {
  return useQuery({
    queryKey: ['connection', 'list'] as const,
    queryFn: () => $fetch<ConnectionsResponse>('/api/connections')
  })
}

export const renameConnection = (id: string, label: string) =>
  $fetch<ConnectionDTO>(`/api/connections/${id}`, { method: 'PATCH', body: { label } })

export const disconnectConnection = (id: string) =>
  $fetch<{ revoked: boolean }>(`/api/connections/${id}`, { method: 'DELETE' })
