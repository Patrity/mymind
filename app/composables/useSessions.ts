import type { SessionListItem, SessionDetail } from '~~/shared/types/session'

export function useSessions() {
  const list = (params?: { source?: string; project?: string }) =>
    $fetch<SessionListItem[]>('/api/sessions', { query: params })

  const get = (id: string) =>
    $fetch<SessionDetail>(`/api/sessions/${id}`)

  return { list, get }
}
