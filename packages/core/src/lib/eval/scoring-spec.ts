// Task 4 fix round 1: an attempt's scoring inputs, snapshotted into eval_results.outcome.scoring.spec at
// attempt time, so the dashboard shows the alignment against what the attempt was actually scored with
// and flags "edited after the run" only when those inputs really changed. Pure (no DB).
import type { EvalCaseRow } from '../../db/schema'
import type { EvalMatchMode, EvalScoringSpec } from '../../shared/types/eval'

export function scoringSpecOf(c: Pick<EvalCaseRow, 'expectedActions' | 'forbiddenActions' | 'expectedContent' | 'matchMode' | 'countFailed' | 'expectedApprovals' | 'forbiddenApprovals' | 'expectFlagged' | 'expectTainted' | 'rubric'>): EvalScoringSpec {
  return {
    expected_actions: c.expectedActions ?? [],
    forbidden_actions: c.forbiddenActions ?? [],
    expected_content: c.expectedContent ?? [],
    match_mode: (c.matchMode as EvalMatchMode) ?? 'ordered_subset',
    count_failed: !!c.countFailed,
    expected_approvals: c.expectedApprovals ?? [],
    forbidden_approvals: c.forbiddenApprovals ?? [],
    expect_flagged: !!c.expectFlagged,
    expect_tainted: !!c.expectTainted,
    rubric: c.rubric ?? null
  }
}

/** JSON with object keys sorted at every depth (jsonb reorders keys; arrays keep their order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export function sameScoringSpec(a: EvalScoringSpec, b: EvalScoringSpec): boolean {
  return canonical(a) === canonical(b)
}
