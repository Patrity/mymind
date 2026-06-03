export type MemoryScope = 'user' | 'agent' | 'world'

export interface MemoryDTO {
  id: string
  scope: MemoryScope
  content: string
  tags: string[]
  source: string | null
  confidence: number | null
  project: string | null
  sessionId: string | null
  enrichedAt: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}
