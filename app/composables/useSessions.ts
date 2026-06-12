import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { SessionListItem, SessionDetail } from '~~/shared/types/session'

export function useSessions() {
  const list = (params?: { source?: string; project?: string }) =>
    $fetch<SessionListItem[]>('/api/sessions', { query: params })

  const get = (id: string) =>
    $fetch<SessionDetail>(`/api/sessions/${id}`)

  const useSessionList = (params?: MaybeRefOrGetter<{ source?: string; project?: string } | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['session', 'list', key.value] as const),
      queryFn: () => list(key.value)
    })
  }

  const useSessionDetail = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['session', key.value] as const),
      queryFn: () => get(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }

  return { list, get, useSessionList, useSessionDetail }
}
