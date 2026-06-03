import { $fetch as ofetch } from 'ofetch'
import type { MemoryDTO, MemoryScope } from '~~/shared/types/memory'

export interface CreateMemoryBody {
  content: string
  scope?: MemoryScope
  project?: string | null
  tags?: string[]
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

  return { list, search, create, review, archive, count }
}
