export interface DocumentDTO {
  id: string
  path: string
  title: string | null
  content: string
  language: string
  frontmatter: Record<string, unknown>
  project: string | null
  domain: string | null
  type: string | null
  tags: string[]
  topic: string | null
  isPublic: boolean
  publicSlug: string | null
  ocrId: string | null
  updatedAt: string
}
export interface DocumentUpsert {
  path: string
  title?: string | null
  content?: string
  frontmatter?: Record<string, unknown>
  project?: string | null
  domain?: string | null
  type?: string | null
  tags?: string[]
  topic?: string | null
}
export interface ChunkHit {
  sourceType: string
  sourceId: string
  ord: number
  content: string
  headingPath: string | null
  context: string | null
  docTitle: string | null
  docPath: string | null
  distance: number
}
