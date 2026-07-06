import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { RangeKey, SeriesResponse, SnapshotResponse, RequestLogResponse } from '~~/shared/types/analytics'

export interface AnalyticsSettings {
  prometheusUrl: string
  litellmUrl: string
  hasLitellmKey: boolean
  gpuLabels: Record<string, string>
}

export function useAnalytics() {
  const qc = useQueryClient()

  const useSnapshot = () => useQuery({
    queryKey: ['analytics', 'snapshot'] as const,
    queryFn: () => $fetch<SnapshotResponse>('/api/analytics/snapshot'),
    refetchInterval: 10_000,
  })

  const useSeries = (panel: string, range: MaybeRefOrGetter<RangeKey>) => {
    const r = computed(() => toValue(range))
    return useQuery({
      queryKey: computed(() => ['analytics', 'series', panel, r.value] as const),
      queryFn: () => $fetch<SeriesResponse>('/api/analytics/series', { query: { panel, range: r.value } }),
      refetchInterval: 30_000,
    })
  }

  const useRequests = (page: MaybeRefOrGetter<number>) => {
    const p = computed(() => toValue(page))
    return useQuery({
      queryKey: computed(() => ['analytics', 'requests', p.value] as const),
      queryFn: () => $fetch<RequestLogResponse>('/api/analytics/requests', { query: { page: p.value, pageSize: 25 } }),
      refetchInterval: 10_000,
      retry: false, // 409 (no key) must not retry-storm
    })
  }

  const useSettings = () => useQuery({
    queryKey: ['analytics', 'config'] as const,
    queryFn: () => $fetch<AnalyticsSettings>('/api/settings/analytics-config'),
  })

  async function saveSettings(patch: Partial<AnalyticsSettings> & { litellmMasterKey?: string }) {
    const saved = await $fetch<AnalyticsSettings>('/api/settings/analytics-config', { method: 'PUT', body: patch })
    qc.setQueryData(['analytics', 'config'], saved)
    qc.invalidateQueries({ queryKey: ['analytics'] })
    return saved
  }

  return { useSnapshot, useSeries, useRequests, useSettings, saveSettings }
}
