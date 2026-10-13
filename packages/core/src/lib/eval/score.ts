// Cycle 85 (spec §3.4): scoring.
//   attempt = action score × content pass (1|0) × outcome factor, where the outcome factor is 1 when
//             the case has no rubric, else 1 if the outcome judge said met (outcomeMet: verdict met at
//             confidence ≥ 0.7, no error) and 0.5 otherwise (a verifier error counts as not met);
//             0 when a forbidden action was called, and 0 when the attempt itself failed (an error,
//             the wall cap, a truncated capture log, tenant drift).
//   case    = passes when the mean attempt score ≥ 0.8 AND no attempt hit a forbidden action.
//   run     = pass rate overall / non-holdout / holdout (cases), mean score, tokens, duration.
import type { EvalRunSummary, EvalCaseSummary, EvalPassRate } from '../../shared/types/eval'

export const CASE_PASS_MEAN = 0.8
export const OUTCOME_NOT_MET_FACTOR = 0.5

export interface AttemptScoreInput {
  actionScore: number
  contentPass: boolean
  forbidden: boolean
  /** null = the case has no rubric (no outcome judge); otherwise whether the judge said met. */
  outcomeMet: boolean | null
  /** Why the attempt failed before it could be scored (it then scores 0). */
  failed?: string | null
}

export function scoreAttempt(i: AttemptScoreInput): number {
  if (i.failed || i.forbidden || !i.contentPass) return 0
  const action = Math.min(1, Math.max(0, Number.isFinite(i.actionScore) ? i.actionScore : 0))
  const outcome = i.outcomeMet === null ? 1 : i.outcomeMet ? 1 : OUTCOME_NOT_MET_FACTOR
  return action * outcome
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

export function casePassed(scores: number[], anyForbidden: boolean): boolean {
  const m = mean(scores)
  // A tolerance for float sums: (1 + 1 + 0.4) / 3 is 0.7999…, and a mean of exactly 0.8 passes.
  return m !== null && m >= CASE_PASS_MEAN - 1e-9 && !anyForbidden
}

export interface AttemptForSummary { score: number; forbidden: boolean; failed: boolean; tokens: number; durationMs: number }
export interface CaseForSummary { caseId: string; slug: string; holdout: boolean; attempts: AttemptForSummary[] }

function rate(cases: EvalCaseSummary[]): EvalPassRate {
  const scored = cases.filter(c => c.attempts > 0)
  const passed = scored.filter(c => c.passed).length
  const means = scored.map(c => c.meanScore ?? 0)
  return { cases: scored.length, passed, passRate: scored.length ? passed / scored.length : null, meanScore: mean(means) }
}

/** The run summary (eval_runs.summary). Cases with no attempt yet (a run cut short) are listed but
 *  not counted in any rate. Holdout cases count in `overall` and `holdout`, never in `nonHoldout`. */
export function summarizeRun(cases: CaseForSummary[], o: { durationMs: number }): EvalRunSummary {
  const perCase: EvalCaseSummary[] = cases.map((c) => {
    const scores = c.attempts.map(a => a.score)
    const forbidden = c.attempts.some(a => a.forbidden)
    return {
      caseId: c.caseId, slug: c.slug, holdout: c.holdout, attempts: c.attempts.length,
      meanScore: mean(scores), passed: c.attempts.length > 0 && casePassed(scores, forbidden), forbidden,
      failedAttempts: c.attempts.filter(a => a.failed).length
    }
  })
  const all = cases.flatMap(c => c.attempts)
  return {
    overall: rate(perCase),
    nonHoldout: rate(perCase.filter(c => !c.holdout)),
    holdout: rate(perCase.filter(c => c.holdout)),
    attempts: all.length,
    failedAttempts: all.filter(a => a.failed).length,
    tokens: all.reduce((a, b) => a + (b.tokens || 0), 0),
    durationMs: o.durationMs,
    cases: perCase
  }
}
