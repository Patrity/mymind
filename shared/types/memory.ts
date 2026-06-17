export type MemoryScope = 'user' | 'agent' | 'world'

export interface MemoryRelationDTO {
  /** Relation type: 'supersedes' | 'contradicts' | 'duplicate-of' */
  type: string
  /** Direction relative to this memory: 'outgoing' (this→other) or 'incoming' (other→this) */
  direction: 'outgoing' | 'incoming'
  otherId: string
  otherContent?: string | null
  status: string
}

export interface MemoryEvidenceEntry {
  sessionId: string | null
  msgIds?: string[]
  quote?: string | null
  reasoning?: string | null
  mergedAt?: string | null
}

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
  sourceDate: string | null
  createdAt: string
  updatedAt: string
  /** Parsed evidence entries from the evidence jsonb column. */
  evidence?: MemoryEvidenceEntry[]
  /** Relations to/from other memories (supersedes, contradicts, etc.) */
  relations?: MemoryRelationDTO[]
  /** Search relevance score [0–1], only present on search results (q non-empty). */
  relevance?: number
}
