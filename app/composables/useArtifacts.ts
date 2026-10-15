import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRef } from 'vue'
import type { ArtifactDTO, ArtifactDetailDTO } from '@mymind/core/shared/types/artifacts'

export interface ArtifactPatch {
  title?: string
  description?: string | null
  slug?: string
  isPublic?: boolean
  projectId?: string | null
  rollbackTo?: number
}

// Keys: ['artifact','list',params] / ['artifact', id] — live SSE events invalidate by the 'artifact' prefix.
export function useArtifactList(params?: MaybeRef<{ projectId?: string } | undefined>) {
  const p = computed(() => toValue(params))
  return useQuery({
    queryKey: ['artifact', 'list', p],
    queryFn: () => $fetch<ArtifactDTO[]>('/api/artifacts', { query: p.value?.projectId ? { project: p.value.projectId } : {} })
  })
}

export function useArtifactDetail(id: MaybeRef<string | undefined>) {
  const i = computed(() => toValue(id))
  return useQuery({
    queryKey: ['artifact', i],
    queryFn: () => $fetch<ArtifactDetailDTO>(`/api/artifacts/${i.value}`),
    enabled: computed(() => !!i.value)
  })
}

// Private URLs embed a 12h token; cache 10 minutes so a long-open page re-mints before expiry.
export function useArtifactViewUrl(id: MaybeRef<string | undefined>) {
  const i = computed(() => toValue(id))
  return useQuery({
    queryKey: ['artifact', i, 'view-url'],
    queryFn: () => $fetch<{ url: string }>(`/api/artifacts/${i.value}/view-url`),
    enabled: computed(() => !!i.value),
    staleTime: 10 * 60 * 1000
  })
}

export const updateArtifact = (id: string, patch: ArtifactPatch) =>
  $fetch<ArtifactDTO>(`/api/artifacts/${id}`, { method: 'PATCH', body: patch })

export const removeArtifact = (id: string) =>
  $fetch<{ ok: true }>(`/api/artifacts/${id}`, { method: 'DELETE' })
