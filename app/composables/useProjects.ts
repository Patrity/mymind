import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ProjectDTO } from '~~/shared/types/tasks'

export function useProjects() {
  const list = (activeOnly = false) =>
    ofetch<ProjectDTO[]>('/api/projects', { query: activeOnly ? { active: 'true' } : {} })

  const create = (body: { name: string, description?: string, slug?: string }) =>
    ofetch<ProjectDTO>('/api/projects', { method: 'POST', body })

  const update = (slug: string, body: { name?: string, description?: string, active?: boolean, color?: string | null, repositoryUrl?: string | null, productionUrl?: string | null, stagingUrl?: string | null, aliases?: string[], slug?: string }) =>
    ofetch<ProjectDTO>(`/api/projects/${slug}`, { method: 'PATCH', body })

  const remove = (slug: string) =>
    ofetch(`/api/projects/${slug}`, { method: 'DELETE' })

  const merge = (slug: string, targetSlug: string) =>
    ofetch<ProjectDTO>(`/api/projects/${slug}/merge`, { method: 'POST', body: { targetSlug } })

  // List key: ['project','list', key] where key is a computed wrapping the
  // MaybeRefOrGetter so vue-query reacts to filter changes.
  // Live SSE events drive cross-tab refresh via the global invalidator.
  const useProjectList = (activeOnly?: MaybeRefOrGetter<boolean | undefined>) => {
    const key = computed(() => toValue(activeOnly))
    return useQuery({
      queryKey: ['project', 'list', key],
      queryFn: () => list(key.value ?? false)
    })
  }

  const useProject = (slug: MaybeRefOrGetter<string | undefined>) => {
    const slugRef = computed(() => toValue(slug))
    return useQuery({
      queryKey: ['project', slugRef],
      queryFn: () => ofetch<ProjectDTO>(`/api/projects/${slugRef.value}`),
      enabled: computed(() => !!slugRef.value)
    })
  }

  const useProjectColors = () => {
    const q = useProjectList()
    const map = computed(() => {
      const m = new Map<string, string | null>()
      for (const p of (q.data.value ?? [])) m.set(p.slug, p.color ?? null)
      return m
    })
    return { map }
  }

  return { list, create, update, remove, merge, useProjectList, useProject, useProjectColors }
}
