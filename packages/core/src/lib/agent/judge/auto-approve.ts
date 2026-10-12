// Cycle 84 (spec §2.3, §2.4): the Smart Approvals rule, as ONE pure function with every input
// explicit — the only place that decides whether a call may run without Tony. Exactly:
//   settings.enabled ∧ surfaceEnabled ∧ verdict.recommendation==='approve'
//   ∧ verdict.confidence ≥ settings.confidence ∧ !verdict.error ∧ ruleFloor ∉ {critical, deny}
//   ∧ !(outbound ∧ runTainted) ∧ nonceUnchanged
// where surfaceEnabled is smartApprovals.workstreams for a workstream, smartApprovals.chat for chat,
// and always false for a headless run (jobs / wakes never auto-run).
import { JUDGE_CONFIDENCE_LIMITS, type ApprovalSurface, type JudgeSettings, type JudgeVerdict, type RuleFloor } from './types'

export interface AutoApproveInput {
  settings: JudgeSettings
  surface: ApprovalSurface
  /** null = the judge has not answered (yet). */
  verdict: JudgeVerdict | null
  ruleFloor: RuleFloor
  /** The tool is `outbound`. */
  outbound: boolean
  /** The run is tainted (read untrusted Google / flagged content). */
  runTainted: boolean
  /** The approval nonce the verdict was produced for is still the pending request's nonce. */
  nonceUnchanged: boolean
}

export type AutoApproveBlocker =
  | 'judge-disabled' | 'surface-disabled' | 'no-verdict' | 'verdict-error' | 'not-approve'
  | 'low-confidence' | 'rule-floor' | 'tainted-outbound' | 'nonce-changed'

/** Why a call may NOT be auto-approved, or null when it may. Checks are ordered, first hit wins. */
export function autoApproveBlocker(i: AutoApproveInput): AutoApproveBlocker | null {
  if (i.settings.enabled !== true) return 'judge-disabled'
  const surfaceEnabled = i.surface === 'workstream'
    ? i.settings.smartApprovals.workstreams === true
    : i.surface === 'chat'
      ? i.settings.smartApprovals.chat === true
      : false
  if (!surfaceEnabled) return 'surface-disabled'
  if (i.nonceUnchanged !== true) return 'nonce-changed'
  if (i.ruleFloor === 'critical' || i.ruleFloor === 'deny') return 'rule-floor'
  if (i.outbound && i.runTainted) return 'tainted-outbound'
  const v = i.verdict
  if (!v) return 'no-verdict'
  if (v.error !== undefined) return 'verdict-error'
  if (v.recommendation !== 'approve') return 'not-approve'
  // A stored threshold below the settings floor (never valid) is read as the floor, never lower.
  const threshold = Number.isFinite(i.settings.confidence) ? Math.max(i.settings.confidence, JUDGE_CONFIDENCE_LIMITS.min) : 1
  if (!Number.isFinite(v.confidence) || v.confidence > 1 || v.confidence < threshold) return 'low-confidence'
  return null
}

/** True only when the call may run without Tony. */
export function autoApprovePredicate(i: AutoApproveInput): boolean {
  return autoApproveBlocker(i) === null
}
