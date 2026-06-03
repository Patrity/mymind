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
