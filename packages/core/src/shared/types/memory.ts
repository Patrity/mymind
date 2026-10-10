export type MemoryScope = 'user' | 'agent' | 'world'
export type MemoryApplicability = 'global' | 'project'
/** The LLM audit's verdict, using the extract-v3 criteria. */
export type AuditVerdict = 'keep' | 'transient' | 'redundant' | 'wrong_scope' | 'belongs_in_doc'

/**
 * |audit − Jev| at or above this is a "disagree" (cycle 77, spec D4). The one definition: the SQL
 * filter in listMemories and the client badge (app/lib/memory/scores.ts) both read it.
 */
export const DISAGREE_THRESHOLD = 0.4

/** `/memories` list sorts. Scores sort worst-first, disagreement largest-first; search ignores them. */
export const MEMORY_SORTS = ['created', 'audit', 'jev', 'disagreement'] as const
export type MemorySort = typeof MEMORY_SORTS[number]

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
  /** Jev's independent read — a second opinion beside `confidence`. Null = not scored yet. */
  jevScore: number | null
  /** The raw per-dimension Jev answers, e.g. `{ transient: 0.76, rederivable: 0.3, ... }`. */
  jevAnswers: Record<string, number> | null
  /** The LLM audit's 0–1 durability read, using the extract-v3 criteria. Null = not audited yet. */
  auditKeep: number | null
  auditVerdict: AuditVerdict | null
  /** The audit's one-line justification, <=200 chars. */
  auditReason: string | null
  auditPromptVersion: string | null
  /** Which revision of the extraction prompt produced this memory. Null for pre-cycle-77 rows. */
  extractPromptVersion: string | null
  project: string | null
  /** 'global' = this fact travels across projects; 'project' = it is bound to `project`. */
  applicability: MemoryApplicability
  /** Always injected into the agent's context, not merely retrievable. Implies applicability 'global'. */
  resident: boolean
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
