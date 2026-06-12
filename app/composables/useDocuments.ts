import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { DocumentDTO } from '~~/shared/types/documents'
import type { TreeNode } from '~~/server/services/tree'

export function useDocuments() {
  const tree = () => ofetch<TreeNode[]>('/api/documents/tree')
  const get = (id: string) => ofetch<DocumentDTO>(`/api/documents/${id}`)
  const create = (body: Partial<DocumentDTO> & { path: string }) => ofetch<DocumentDTO>('/api/documents', { method: 'POST', body })
  const update = (id: string, body: Partial<DocumentDTO>) => ofetch<DocumentDTO>(`/api/documents/${id}`, { method: 'PUT', body })
  const remove = (id: string) => ofetch(`/api/documents/${id}`, { method: 'DELETE' })
  const move = (id: string, path: string) => ofetch<DocumentDTO>(`/api/documents/${id}/move`, { method: 'POST', body: { path } })
  const share = (id: string, isPublic: boolean) => ofetch<DocumentDTO>(`/api/documents/${id}/share`, { method: 'POST', body: { isPublic } })
  const search = (q: string) => ofetch<DocumentDTO[]>('/api/documents/search', { query: { q } })

  const useDocTree = () =>
    useQuery({
      queryKey: ['document', 'list'] as const,
      queryFn: () => tree()
    })

  const useDocDetail = (id: MaybeRefOrGetter<string | null | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['document', key.value] as const),
      queryFn: () => get(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }

  return { tree, get, create, update, remove, move, share, search, useDocTree, useDocDetail }
}
