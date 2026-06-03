export interface ImageDTO {
  id: string
  storageKey: string
  originalName: string | null
  mime: string
  ext: string
  kind: string
  width: number | null
  height: number | null
  size: number
  ocrText: string | null
  tags: string[]
  recommendedTags: string[]
  isPublic: boolean
  publicSlug: string | null
  createdAt: string
  deletedAt: string | null
  url: string
}
