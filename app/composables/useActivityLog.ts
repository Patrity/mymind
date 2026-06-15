import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ActivityDTO, ActivityListParams } from '~~/shared/types/activity'

export function useActivityLog() {
  const useActivityList = (params?: MaybeRefOrGetter<ActivityListParams | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['activity', 'list', key.value] as const),
      queryFn: () => $fetch<ActivityDTO[]>('/api/activity', { query: key.value })
    })
  }

  const useActivityDetail = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['activity', key.value] as const),
      queryFn: () => $fetch<{ root: ActivityDTO, trace: ActivityDTO[] }>(`/api/activity/${key.value}`),
      enabled: computed(() => !!key.value)
    })
  }

  return { useActivityList, useActivityDetail }
}
