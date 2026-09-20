import { useQuery, useInfiniteQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type {
  SessionListItem,
  SessionMeta,
  SessionMessageDTO,
  SessionMessages,
  SessionMessageFilters,
  SessionMessagesPage
} from '~~/shared/types/session'

/** Only the filters that are actually set: an absent key keeps the request URL (and so the
 *  server's call shape) identical to the unfiltered read. */
function filterQuery(filters: SessionMessageFilters) {
  return {
    ...(filters.hideSidechain ? { hideSidechain: 'true' } : {}),
    ...(filters.tool ? { tool: filters.tool } : {}),
    ...(filters.q ? { q: filters.q } : {})
  }
}

/** The paged-transcript cache key. Exported so the page's live-tail can append to the exact
 *  cache the infinite query reads from — filters included, since they're part of the key. */
export function messagePagesKey(id: string, filters: SessionMessageFilters) {
  return ['session', id, 'messages', 'paged', filters] as const
}

export function useSessions() {
  const list = (params?: { source?: string; project?: string }) =>
    $fetch<SessionListItem[]>('/api/sessions', { query: params })

  const getMeta = (id: string) => $fetch<SessionMeta>(`/api/sessions/${id}`)
  /** The live-tail delta: every message after `since` — the newest row the caller already holds,
   *  passed WHOLE (timestamp *and* id). The server compares `(created_at, id)`, the same
   *  composite the paged read walks; a timestamp alone would silently drop every row sharing
   *  that created_at, permanently, and 26% of messages share one with a sibling.
   *  The active filters ride along so the server decides what belongs — a delta filtered in the
   *  client would put rows the filter excludes back into a narrowed list. Call it WITH `since`:
   *  without one the endpoint answers with a keyset PAGE (newest-first, capped at 100), not the
   *  whole transcript — for that use `useSessionMessagePages`. */
  const getMessages = (
    id: string,
    since?: Pick<SessionMessageDTO, 'id' | 'createdAt'>,
    filters: SessionMessageFilters = {}
  ) =>
    $fetch<SessionMessages>(`/api/sessions/${id}/messages`, {
      query: {
        ...(since ? { since: since.createdAt, sinceId: since.id } : {}),
        ...filterQuery(filters)
      }
    })

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

  /** One page of the transcript, walking backwards from `before` (newest-first within the page). */
  const getMessagePage = (id: string, before: string | undefined, filters: SessionMessageFilters) =>
    $fetch<SessionMessagesPage>(`/api/sessions/${id}/messages`, {
      query: {
        ...(before ? { before } : {}),
        ...filterQuery(filters)
      }
    })

  const useSessionMessagePages = (
    id: MaybeRefOrGetter<string | undefined>,
    filters: MaybeRefOrGetter<SessionMessageFilters>
  ) => {
    const key = computed(() => toValue(id))
    // Filters live IN the key: changing one is a new query and a clean first page, with no
    // manual reset and no stale pages bleeding across filters.
    // NOTE: `toValue` does NOT unwrap a plain `reactive()` object, so pass a ref or a getter —
    // a bare reactive here registers no dependency and filter changes never refetch.
    const f = computed(() => toValue(filters))
    return useInfiniteQuery({
      queryKey: computed(() => messagePagesKey(key.value as string, f.value)),
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
    getMessages,
    getMessagePage,
    useSessionMessagePages,
    reassign,
    reassignMany
  }
}
