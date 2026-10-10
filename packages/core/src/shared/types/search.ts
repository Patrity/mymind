export type SearchHitType =
  'document' | 'memory' | 'image' | 'task' | 'project' | 'session' | 'message'

export interface SearchHit {
  type: SearchHitType
  id: string
  title: string            // primary display line
  snippet: string | null   // matched passage / excerpt (may contain the matched phrase)
  score: number            // raw rerank score (0..1) when reranked, else synthetic RRF order
  to: string               // route
  icon: string             // lucide icon name
  meta: string | null      // type-specific: doc path / memory scope / task status / session project / msg role
}

export interface SearchResults {
  hits: SearchHit[]        // globally ranked, post-cutoff
  reranked: boolean        // true when the cross-encoder produced the scores (controls score-badge display)
}

// Lane-level shapes still produced by session-search.ts and consumed by the aggregator.
export interface SessionResult {
  type: 'session'
  id: string
  title: string
  snippet: string
  project: string | null
  to: string
}

export interface MessageResult {
  type: 'message'
  id: string
  sessionId: string
  role: string | null
  snippet: string
  to: string
}
