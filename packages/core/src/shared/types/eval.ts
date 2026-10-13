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
  /** Fix round 1: the flag was the fail-closed kind (the check could not run), not a verdict. */
  unverified?: true
  /** The thread it ran in (a coordinator's child has its own). */
  conversationId: string
}

/** Task 4 fix round 1: what an attempt was scored AGAINST — the case's scoring inputs at attempt time
 *  (field names as in the case JSON). The attempt page aligns against this, not the case as edited since. */
export interface EvalScoringSpec {
  expected_actions: Array<{ tool: string; args?: Record<string, unknown>; args_pattern?: Record<string, string> }>
  forbidden_actions: Array<{ tool: string; args?: Record<string, unknown>; args_pattern?: Record<string, string> }>
  expected_content: string[]
  match_mode: EvalMatchMode
  count_failed: boolean
  expected_approvals: Array<{ tool: string }>
  forbidden_approvals: Array<{ tool: string }>
  expect_flagged: boolean
  expect_tainted: boolean
  rubric: string | null
}

export interface EvalAttemptScoring {
  /** Task 4 fix round 1: the scoring inputs snapshot (absent on results written before it). */
  spec?: EvalScoringSpec
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
  /** Fix round 1 (S1/S2): the case's extra checks. null = the case did not ask for that check. */
  checks: {
    /** expect_flagged: a matched call's result carried a real output-guard flag. */
    flagged: boolean | null
    /** expect_tainted: the run ended tainted (its sources). */
    tainted: boolean | null
    taintSources: string[]
    /** expected_approvals the scripted approver was never asked for. */
    approvalsMissing: string[]
    /** forbidden_approvals that were raised (a forbidden hit): forbidden index → approvals index. */
    forbiddenApprovals: Array<{ forbidden: number; approval: number }>
    pass: boolean
  }
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

// ── Task 4: the /evals dashboard's read models (lib/eval/dashboard.ts builds them) ─────────────

/** One point of a suite's pass-rate trend (a finished run, oldest first). */
export interface EvalTrendPoint { runId: string; at: string; passRate: number | null; meanScore: number | null; status: EvalRunStatus }

export interface EvalSuiteOverview {
  id: string
  name: string
  description: string
  cases: number
  enabledCases: number
  updatedAt: string
  /** The newest run, whatever its state (a running one shows its progress). */
  lastRun: EvalRunDTO | null
  /** Non-holdout pass rate of the last finished (done) runs, oldest first. */
  trend: EvalTrendPoint[]
}

/** A case as the suite page lists it. */
export interface EvalCaseListItem {
  id: string
  slug: string
  surface: 'chat' | 'workstream'
  prompt: string
  matchMode: EvalMatchMode
  holdout: boolean
  enabled: boolean
  nRuns: number
  hasRubric: boolean
  updatedAt: string
}

export interface EvalSuiteDetail {
  suite: { id: string; name: string; description: string; updatedAt: string }
  cases: EvalCaseListItem[]
  /** Newest first. */
  runs: EvalRunDTO[]
}

/** A case in the editor: its JSON (the import format) plus where it lives. */
export interface EvalCaseView {
  id: string
  suiteId: string
  suiteName: string
  updatedAt: string
  json: Record<string, unknown>
}

/** An attempt as the run page lists it (no tool log / writes / text — the attempt page has those). */
export interface EvalResultLite {
  id: string
  caseId: string
  attempt: number
  score: number | null
  passed: boolean | null
  error: string | null
  failed: string | null
  forbidden: boolean
  verdict: 'met' | 'partial' | 'unmet' | null
  durationMs: number | null
  tokens: number | null
}

export interface EvalRunView {
  run: EvalRunDTO
  suite: { id: string; name: string }
  /** Every case the run planned or scored (slug order). */
  cases: Array<{ id: string; slug: string; holdout: boolean; surface: 'chat' | 'workstream' }>
  results: EvalResultLite[]
}

export interface EvalAttemptView {
  result: EvalResultDTO
  run: EvalRunDTO
  suite: { id: string; name: string }
  /** The case as it is NOW. `editedSince`: its scoring inputs differ from the attempt's snapshot
   *  (`scoring.spec`) — or, for a result written before snapshots, it was edited after the run started.
   *  Null when the case was deleted. */
  case: { id: string; slug: string; updatedAt: string; editedSince: boolean; json: Record<string, unknown> } | null
}
