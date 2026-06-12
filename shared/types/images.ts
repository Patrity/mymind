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
  summary: string | null
  enrichStatus: string
  enrichError: string | null
  enrichAttempts: number
  makeDocument: boolean
  tags: string[]
  recommendedTags: string[]
  isPublic: boolean
  publicSlug: string | null
  createdAt: string
  deletedAt: string | null
  url: string
}
