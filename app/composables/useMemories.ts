import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { MemoryDTO, MemoryScope } from '~~/shared/types/memory'

export interface CreateMemoryBody {
  content: string
  scope?: MemoryScope
  project?: string | null
  tags?: string[]
}

export interface MemoryListParams {
  q?: string
  scope?: MemoryScope
  reviewed?: boolean
  limit?: number
}

export function useMemories() {
  const list = (params?: { scope?: MemoryScope, reviewed?: boolean, limit?: number }) =>
    ofetch<MemoryDTO[]>('/api/memories', { query: params })

  const search = (q: string, params?: { scope?: MemoryScope, limit?: number }) =>
    ofetch<MemoryDTO[]>('/api/memories', { query: { q, ...params } })

  const create = (body: CreateMemoryBody) =>
    ofetch<MemoryDTO>('/api/memories', { method: 'POST', body })

  const review = (id: string) =>
    ofetch<{ ok: boolean }>(`/api/memories/${id}/review`, { method: 'POST' })

  const archive = (id: string) =>
    ofetch<{ ok: boolean }>(`/api/memories/${id}/archive`, { method: 'POST' })

  const count = () =>
    ofetch<{ unreviewed: number }>('/api/memories/count')

  /**
   * Reactive query for the memory list. Switches between search and list mode
   * based on whether params.q is set. Use listParams as a computed in the caller
   * so changes to filters trigger a refetch.
   */
  const useMemoryList = (params?: MaybeRefOrGetter<MemoryListParams | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: ['memory', 'list', key] as const,
      queryFn: () => {
        const p = key.value
        const q = p?.q?.trim()
        if (q) {
          return search(q, { scope: p?.scope, limit: p?.limit })
        }
        return list({ scope: p?.scope, reviewed: p?.reviewed, limit: p?.limit })
      }
    })
  }

  return { list, search, create, review, archive, count, useMemoryList }
}
