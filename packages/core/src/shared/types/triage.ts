// A DESTINATION, not a document classification. Deliberately NOT shared with
// documents.type ('note'|'reference'|'meeting'|'idea'|'task') — the two overlap
// on two words while meaning different things. Do not unify them.
export type TriageKind = 'task' | 'note' | 'memory' | 'append'

export interface TriageAction {
  kind: TriageKind
  confidence: number                      // 0..1, clamped
  title?: string
  project?: string | null
  priority?: 'low' | 'medium' | 'high'    // task only
  dueDate?: string | null                 // task only, ISO date
  scope?: 'user' | 'agent' | 'world'      // memory only
  content?: string                        // memory text / append block text
  targetDocId?: string                    // append only — resolved by the actuator, never the model
  tags?: string[]
  path?: string                           // note only — destination path INCLUDING the new filename
}

export interface TriageProposal {
  primary: TriageAction
  secondary: TriageAction[]               // 0..2 (truncated, not rejected)
  reasoning: string
}

export interface TriageOutcome {
  docId: string
  applied: TriageAction[]
  queued: boolean                         // true if a review_queue row was created
  skipped?: 'already-triaged' | 'parse-failed' | 'review-pending'
}
