import { useQuery, useInfiniteQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type {
  SessionListItem,
  SessionMeta,
  SessionMessages,
  SessionMessageFilters,
  SessionMessagesPage
} from '~~/shared/types/session'

export function useSessions() {
  const list = (params?: { source?: string; project?: string }) =>
    $fetch<SessionListItem[]>('/api/sessions', { query: params })

  const getMeta = (id: string) => $fetch<SessionMeta>(`/api/sessions/${id}`)
  const getMessages = (id: string, since?: string) =>
    $fetch<SessionMessages>(`/api/sessions/${id}/messages`, { query: since ? { since } : {} })

  const useSessionList = (params?: MaybeRefOrGetter<{ source?: string; project?: string } | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['session', 'list', key.value] as const),
      queryFn: () => list(key.value)
    })
  }

  const useSessionMeta = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['session', key.value] as const),
      queryFn: () => getMeta(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }

  const useSessionMessages = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['session', key.value, 'messages'] as const),
      queryFn: () => getMessages(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }

  /** One page of the transcript, walking backwards from `before` (newest-first within the page). */
  const getMessagePage = (id: string, before: string | undefined, filters: SessionMessageFilters) =>
    $fetch<SessionMessagesPage>(`/api/sessions/${id}/messages`, {
      query: {
        ...(before ? { before } : {}),
        ...(filters.hideSidechain ? { hideSidechain: 'true' } : {}),
        ...(filters.tool ? { tool: filters.tool } : {}),
        ...(filters.q ? { q: filters.q } : {})
      }
    })

  const useSessionMessagePages = (
    id: MaybeRefOrGetter<string | undefined>,
    filters: MaybeRefOrGetter<SessionMessageFilters>
  ) => {
    const key = computed(() => toValue(id))
    // Filters live IN the key: changing one is a new query and a clean first page, with no
    // manual reset and no stale pages bleeding across filters.
    const f = computed(() => toValue(filters))
    return useInfiniteQuery({
      queryKey: computed(() => ['session', key.value, 'messages', 'paged', f.value] as const),
      queryFn: ({ pageParam }) => getMessagePage(key.value as string, pageParam as string | undefined, f.value),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: SessionMessagesPage) => last.nextCursor ?? undefined,
      enabled: computed(() => !!key.value)
    })
  }

  const reassign = (id: string, body: { project: string, pathPrefix?: string | null }) =>
    $fetch<{ ok: true, from: string | null, to: string }>(`/api/sessions/${id}`, { method: 'PATCH', body })
  const reassignMany = (body: { ids: string[], project: string, pathPrefix?: string | null }) =>
    $fetch<{ ok: true, count: number }>(`/api/sessions/reassign`, { method: 'POST', body })

  return {
    list,
    useSessionList,
    useSessionMeta,
    useSessionMessages,
    getMessages,
    getMessagePage,
    useSessionMessagePages,
    reassign,
    reassignMany
  }
}
