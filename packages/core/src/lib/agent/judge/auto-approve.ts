// Cycle 84 (spec §2.3, §2.4): the Smart Approvals rule, as ONE pure function with every input
// explicit — the only place that decides whether a call may run without Tony. Exactly:
//   settings.enabled ∧ surfaceEnabled ∧ verdict.recommendation==='approve'
//   ∧ verdict.confidence ≥ settings.confidence ∧ !verdict.error ∧ ruleFloor ∉ {high, critical, deny}
//   ∧ !(outbound ∧ runTainted) ∧ nonceUnchanged
// plus (fix round 1 rulings): verdict.risk ∈ {low, medium}, and a verdict parsed by the lenient text
// fallback never auto-approves.
// where surfaceEnabled is smartApprovals.workstreams for a workstream, smartApprovals.chat for chat,
// and always false for a headless run (jobs / wakes never auto-run).
// Amended 2026-10-12 (coordinator ruling on spec D6 "no rule flag"): a `high` rule floor blocks too.
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
  | 'judge-disabled' | 'surface-disabled' | 'no-verdict' | 'verdict-error' | 'lenient-verdict' | 'not-approve'
  | 'risk-too-high' | 'low-confidence' | 'rule-floor' | 'tainted-outbound' | 'nonce-changed'

/** Rule floors a call may be auto-approved at (an allow-list, so an unknown value blocks). */
const AUTO_FLOORS: ReadonlySet<string> = new Set(['low', 'review'])
/** Judge risks a call may be auto-approved at (fix round 1: approve at high/critical risk blocks). */
const AUTO_RISKS: ReadonlySet<string> = new Set(['low', 'medium'])

/**
 * Why a call may NOT be auto-approved, or null when it may. Checks are ordered, first hit wins.
 * Fail-closed on malformed input (fix round 1): every boolean that ALLOWS must be exactly `true`,
 * every one that FORBIDS blocks unless it is exactly `false`, and a missing object blocks.
 */
export function autoApproveBlocker(i: AutoApproveInput): AutoApproveBlocker | null {
  const s = i?.settings
  if (s?.enabled !== true) return 'judge-disabled'
  const surfaceEnabled = i.surface === 'workstream'
    ? s.smartApprovals?.workstreams === true
    : i.surface === 'chat'
      ? s.smartApprovals?.chat === true
      : false
  if (!surfaceEnabled) return 'surface-disabled'
  if (i.nonceUnchanged !== true) return 'nonce-changed'
  if (!AUTO_FLOORS.has(i.ruleFloor)) return 'rule-floor'
  if (!(i.outbound === false || i.runTainted === false)) return 'tainted-outbound'
  const v = i.verdict
  if (!v) return 'no-verdict'
  if (v.error !== undefined) return 'verdict-error'
  if (v.lenient !== undefined) return 'lenient-verdict'
  if (v.recommendation !== 'approve') return 'not-approve'
  if (!AUTO_RISKS.has(v.risk as string)) return 'risk-too-high'
  // Task 2 carry: an invalid stored threshold (not a finite number in the settings range) means no
  // auto-approval at all — never a fallback threshold a verdict could still meet.
  const threshold = s.confidence
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < JUDGE_CONFIDENCE_LIMITS.min || threshold > JUDGE_CONFIDENCE_LIMITS.max) return 'low-confidence'
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence > 1 || v.confidence < threshold) return 'low-confidence'
  return null
}

/** True only when the call may run without Tony. */
export function autoApprovePredicate(i: AutoApproveInput): boolean {
  return autoApproveBlocker(i) === null
}
