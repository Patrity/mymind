// Cycle 85 (spec §3): the eval substrate's DTOs — what the runner stores (eval_runs.summary,
// eval_results.tool_log / outcome) and what the /evals dashboard (Task 4) renders.

export type EvalMatchMode = 'ordered_subset' | 'exact' | 'subset' | 'contains_any'
export type EvalRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export const EVAL_RUN_TERMINAL: readonly EvalRunStatus[] = ['done', 'failed', 'cancelled']

/** What a run was asked to do (eval_runs.params). */
export interface EvalRunParams {
  /** Case slugs to run (absent = every enabled case of the suite). */
  cases?: string[]
  /** Attempts per case (absent = each case's n_runs). */
  n?: number
  /** A registry model id to run on instead of the reasoning chain's head. */
  model?: string
}

export interface EvalPassRate {
  /** Cases with at least one attempt. */
  cases: number
  passed: number
  /** passed / cases; null when no case was scored. */
  passRate: number | null
  /** Mean of the cases' mean scores; null when none. */
  meanScore: number | null
}

export interface EvalCaseSummary {
  caseId: string
  slug: string
  holdout: boolean
  attempts: number
  meanScore: number | null
  passed: boolean
  /** Some attempt called a forbidden action (the case fails whatever its mean). */
  forbidden: boolean
  failedAttempts: number
}

/** eval_runs.summary — rewritten after every attempt (live progress), final at the end. */
export interface EvalRunSummary {
  overall: EvalPassRate
  /** The numbers to compare runs by: holdout cases never count here. */
  nonHoldout: EvalPassRate
  holdout: EvalPassRate
  attempts: number
  failedAttempts: number
  tokens: number
  durationMs: number
  cases: EvalCaseSummary[]
  /** Attempts the run will make in total (progress = attempts / planned). */
  planned?: number
  /** Per-case sha256 of the assembled system prompt (slug → hash); the run's prompt_hash hashes these. */
  promptHashes?: Record<string, string>
}

/** One tool call of an attempt, in call order across every thread of its world (eval_results.tool_log). */
export interface EvalToolLogEntry {
  tool: string
  /** The arguments as the model sent them (string values capped at 2000 chars). */
  args: Record<string, unknown>
  status: 'ok' | 'error' | 'denied' | 'pending'
  /** Result digest (≤ 500 chars). */
  result: string
  /** The output guard flagged the result (its source). */
  flagged?: string
  /** The thread it ran in (a coordinator's child has its own). */
  conversationId: string
}

export interface EvalAttemptScoring {
  mode: EvalMatchMode
  actionScore: number
  /** expected action index → tool_log index. */
  matched: Array<{ expected: number; call: number }>
  unmatched: number[]
  /** tool_log indexes no expected action used. */
  extra: number[]
  /** forbidden action index → tool_log index. */
  forbidden: Array<{ forbidden: number; call: number }>
  content: { pass: boolean; missing: string[] }
  /** null = the case has no rubric. */
  outcomeMet: boolean | null
  /** Why the attempt failed before scoring (error, wall cap, truncated capture, tenant drift). */
  failed: string | null
}

/** eval_results.outcome */
export interface EvalAttemptOutcome {
  /** The outcome judge's verdict (rubric as the goal); null when the case has no rubric. */
  judge: { verdict: 'met' | 'partial' | 'unmet' | null; confidence: number; gaps: string[]; nextStep: string | null; model: string | null; latencyMs: number; error?: string } | null
  scoring: EvalAttemptScoring
  /** Approval cards the scripted approver answered. */
  approvals: Array<{ tool: string; approved: boolean }>
}

export interface EvalRunDTO {
  id: string
  suiteId: string
  status: EvalRunStatus
  gitSha: string | null
  modelLabel: string | null
  promptHash: string | null
  toolsHash: string | null
  params: EvalRunParams
  summary: EvalRunSummary | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface EvalResultDTO {
  id: string
  runId: string
  caseId: string
  attempt: number
  score: number | null
  passed: boolean | null
  toolLog: EvalToolLogEntry[]
  finalText: string | null
  outcome: EvalAttemptOutcome | null
  capturedWrites: Array<{ kind: string; at: number; detail: Record<string, unknown> }>
  error: string | null
  durationMs: number | null
  tokens: number | null
  createdAt: string
}
