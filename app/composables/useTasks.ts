import { $fetch as ofetch } from 'ofetch'
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

  return { list, get, create, update, move, remove }
}
