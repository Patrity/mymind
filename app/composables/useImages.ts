import { $fetch as ofetch } from 'ofetch'
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

  const upload = (file: File, isPublic = false) => {
    const fd = new FormData()
    fd.append('file', file)
    return ofetch<ImageDTO>(`/api/upload${isPublic ? '?public=1' : ''}`, { method: 'POST', body: fd })
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    ofetch<ImageDTO>(`/api/images/${id}`, { method: 'PATCH', body })

  const remove = (id: string) => ofetch(`/api/images/${id}`, { method: 'DELETE' })

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

  return { list, upload, patch, remove, setPublic, approveTag, dismissTag, removeTag }
}
