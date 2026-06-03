import { $fetch as ofetch } from 'ofetch'
import type { ProjectDTO } from '~~/shared/types/tasks'

export function useProjects() {
  const list = (activeOnly = false) =>
    ofetch<ProjectDTO[]>('/api/projects', { query: activeOnly ? { active: 'true' } : {} })

  const create = (body: { name: string, description?: string }) =>
    ofetch<ProjectDTO>('/api/projects', { method: 'POST', body })

  const update = (slug: string, body: { name?: string, description?: string, active?: boolean }) =>
    ofetch<ProjectDTO>(`/api/projects/${slug}`, { method: 'PATCH', body })

  const remove = (slug: string) =>
    ofetch(`/api/projects/${slug}`, { method: 'DELETE' })

  return { list, create, update, remove }
}
