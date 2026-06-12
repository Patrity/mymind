import { $fetch as ofetch } from 'ofetch'
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { toValue, type MaybeRefOrGetter } from 'vue'
import type { ImageDTO } from '~~/shared/types/images'

export interface ListImagesParams {
  q?: string
  tags?: string[]
}

export function useImages() {
  const list = (params?: ListImagesParams) => {
    const query: Record<string, string> = {}
    if (params?.q?.trim()) query.q = params.q.trim()
    if (params?.tags?.length) query.tags = params.tags.join(',')
    const qs = new URLSearchParams(query).toString()
    return ofetch<ImageDTO[]>(`/api/images${qs ? `?${qs}` : ''}`)
  }

  const upload = (file: File, isPublic = false, makeDocument = false) => {
    const fd = new FormData()
    fd.append('file', file)
    const qs = [isPublic ? 'public=1' : '', makeDocument ? 'makeDocument=1' : ''].filter(Boolean).join('&')
    return ofetch<ImageDTO>(`/api/upload${qs ? `?${qs}` : ''}`, { method: 'POST', body: fd })
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    ofetch<ImageDTO>(`/api/images/${id}`, { method: 'PATCH', body })

  const remove = (id: string) => ofetch(`/api/images/${id}`, { method: 'DELETE' })

  const reprocess = (id: string) => ofetch<ImageDTO>(`/api/images/${id}/reprocess`, { method: 'POST' })

  const revectorize = (id: string) => ofetch<ImageDTO>(`/api/images/${id}/revectorize`, { method: 'POST' })

  const updateMeta = (id: string, body: { summary?: string | null, ocrText?: string | null, tags?: string[], recommendedTags?: string[] }) =>
    patch(id, body)

  const addTag = (img: ImageDTO, tag: string) => {
    // Dedup guard: no-op if empty or already present (case-sensitive, matching tag model)
    const trimmed = tag.trim()
    if (!trimmed || img.tags.includes(trimmed)) return Promise.resolve(img)
    return patch(img.id, { tags: [...img.tags, trimmed], recommendedTags: img.recommendedTags.filter(t => t !== trimmed) })
  }

  const setPublic = (id: string, isPublic: boolean) => patch(id, { isPublic })

  const approveTag = (img: ImageDTO, tag: string) =>
    patch(img.id, {
      tags: [...img.tags, tag],
      recommendedTags: img.recommendedTags.filter(t => t !== tag)
    })

  const dismissTag = (img: ImageDTO, tag: string) =>
    patch(img.id, { recommendedTags: img.recommendedTags.filter(t => t !== tag) })

  const removeTag = (img: ImageDTO, tag: string) =>
    patch(img.id, { tags: img.tags.filter(t => t !== tag) })

  const qc = useQueryClient()

  // List key ['image','list', params]; partial-key invalidation on ['image','list']
  // refetches every filter variant. Live SSE events drive cross-tab refresh.
  const useImageList = (params?: MaybeRefOrGetter<ListImagesParams | undefined>) =>
    useQuery({
      queryKey: ['image', 'list', params],
      queryFn: () => list(toValue(params))
    })

  // Acting tab invalidates locally; other tabs are covered by the SSE event.
  const usePatchImage = () =>
    useMutation({
      mutationFn: (vars: { id: string, body: Record<string, unknown> }) => patch(vars.id, vars.body),
      onSuccess: (_d, vars) => {
        qc.invalidateQueries({ queryKey: ['image', vars.id] })
        qc.invalidateQueries({ queryKey: ['image', 'list'] })
      }
    })

  return { list, upload, patch, remove, setPublic, approveTag, dismissTag, removeTag, reprocess, revectorize, updateMeta, addTag, useImageList, usePatchImage }
}
