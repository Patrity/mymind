import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { AuditVerdict, MemoryDTO, MemoryScope } from '~~/shared/types/memory'

export interface CreateMemoryBody {
  content: string
  scope?: MemoryScope
  project?: string | null
  tags?: string[]
}

/** Score filters (cycle 77). They apply to list AND search. */
export interface MemoryScoreParams {
  verdict?: AuditVerdict
  /** 'yes' = both audit and Jev present; 'no' = either missing. */
  scored?: 'yes' | 'no'
  /** '1' = both scores present and |audit − Jev| ≥ 0.4. */
  disagree?: '1'
}

/** List-only: search keeps its relevance order. Scores sort worst-first, disagreement largest-first. */
export type MemorySort = 'created' | 'audit' | 'jev' | 'disagreement'

export interface MemoryListParams extends MemoryScoreParams {
  q?: string
  scope?: MemoryScope
  reviewed?: boolean
  project?: string
  limit?: number
  sort?: MemorySort
}

export function useMemories() {
  const list = (params?: Omit<MemoryListParams, 'q'>) =>
    ofetch<MemoryDTO[]>('/api/memories', { query: params })

  const search = (q: string, params?: { scope?: MemoryScope, project?: string, limit?: number } & MemoryScoreParams) =>
    ofetch<MemoryDTO[]>('/api/memories', { query: { q, ...params } })

  const get = (id: string) =>
    ofetch<MemoryDTO>(`/api/memories/${id}`)

  const create = (body: CreateMemoryBody) =>
    ofetch<MemoryDTO>('/api/memories', { method: 'POST', body })

  const patch = (id: string, body: { content?: string, scope?: MemoryScope, project?: string | null, tags?: string[] }) =>
    ofetch<MemoryDTO>(`/api/memories/${id}`, { method: 'PATCH', body })

  const review = (id: string) =>
    ofetch<{ ok: boolean }>(`/api/memories/${id}/review`, { method: 'POST' })

  // Archive == delete; the response carries an undoToken (POST /api/agent/undo).
  const archive = (id: string) =>
    ofetch<{ ok: boolean, undoToken?: string }>(`/api/memories/${id}/archive`, { method: 'POST' })

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
        const scores = { verdict: p?.verdict, scored: p?.scored, disagree: p?.disagree }
        if (q) {
          return search(q, { scope: p?.scope, project: p?.project, limit: p?.limit, ...scores })
        }
        return list({ scope: p?.scope, reviewed: p?.reviewed, project: p?.project, limit: p?.limit, sort: p?.sort, ...scores })
      }
    })
  }

  return { list, search, get, create, patch, review, archive, count, useMemoryList }
}
