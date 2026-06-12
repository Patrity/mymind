import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { TaskDTO, TaskStatus } from '~~/shared/types/tasks'

export function useTasks() {
  const list = (params?: { status?: TaskStatus, project?: string }) =>
    ofetch<TaskDTO[]>('/api/tasks', { query: params })

  const get = (id: string) =>
    ofetch<TaskDTO>(`/api/tasks/${id}`)

  const create = (body: {
    title: string
    description?: string
    status?: TaskStatus
    priority?: 'low' | 'medium' | 'high'
    dueDate?: string | null
    project?: string | null
  }) => ofetch<TaskDTO>('/api/tasks', { method: 'POST', body })

  const update = (id: string, body: {
    title?: string
    description?: string
    status?: TaskStatus
    priority?: 'low' | 'medium' | 'high'
    dueDate?: string | null
    project?: string | null
    order?: number
  }) => ofetch<TaskDTO>(`/api/tasks/${id}`, { method: 'PATCH', body })

  const move = (id: string, body: { status?: TaskStatus, order?: number }) =>
    ofetch<TaskDTO>(`/api/tasks/${id}/move`, { method: 'POST', body })

  const remove = (id: string) =>
    ofetch(`/api/tasks/${id}`, { method: 'DELETE' })

  // List key ['task','list', project]; partial-key invalidation on ['task','list']
  // (driven by live SSE events) refetches every filter variant. `filter` is the
  // project slug (or undefined for "all"); wrapped in a computed so vue-query
  // unwraps it reactively and refetches when the filter changes. Mirrors list()'s
  // own filter signature — we pass it as `{ project }`.
  const useTaskList = (filter?: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(filter))
    return useQuery({
      queryKey: ['task', 'list', key],
      queryFn: () => list(key.value ? { project: key.value } : undefined)
    })
  }

  return { list, get, create, update, move, remove, useTaskList }
}
