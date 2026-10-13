// app/lib/agent/judge-display.ts
// Cycle 84 Task 4: what the approval card, the thread note, the output-warning chip and the Smart
// Approvals settings show of the judge. Pure, so the guarding logic is unit-tested without
// mounting a component.
//
// Every string that comes out of here and originates from a model (verdict reasons, the auto-
// approval reason, the guard classifier's reasons) is returned as PLAIN TEXT for `{{ }}`
// interpolation — never markup. The components must not v-html or markdown-render them
// (test/judge-ui-sources.test.ts pins that).
import type { AgentUIMessage } from '@mymind/core/shared/types/agent-ui'
import {
  JUDGE_CONFIDENCE_LIMITS,
  type ApprovalVerdictDTO,
  type GuardSource,
  type OutputWarningDTO,
  type Recommendation,
  type Risk,
  type RuleFloor,
  type TaintSource,
  type ToolApprovalNote
} from '@mymind/core/lib/agent/judge/types'

export type UiColor = 'success' | 'warning' | 'error' | 'info' | 'neutral'

/** Risk → a semantic Nuxt UI colour. An unknown/absent risk (an error verdict) is neutral. */
export function riskColor(risk: Risk | null | undefined): UiColor {
  switch (risk) {
    case 'low': return 'success'
    case 'medium': return 'warning'
    case 'high':
    case 'critical': return 'error'
    default: return 'neutral'
  }
}

export function recommendationColor(rec: Recommendation): UiColor {
  return rec === 'approve' ? 'success' : rec === 'deny' ? 'error' : 'warning'
}

/** Two decimals, clamped to 0–1: "0.94". */
export function formatConfidence(c: number): string {
  const v = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
  return v.toFixed(2)
}

/** Rule floors worth showing on the card: the ones that put the call on Tony regardless of the
 *  verdict. `review`/`low` are the ordinary case and add nothing. */
export function floorShown(floor: RuleFloor | undefined): boolean {
  return floor === 'high' || floor === 'critical' || floor === 'deny'
}

export type VerdictView =
  | { kind: 'pending'; autoPossible: boolean; rule: { floor: RuleFloor; reasons: string[] } | null; taint: string | null }
  | { kind: 'error'; error: string; rule: { floor: RuleFloor; reasons: string[] } | null; taint: string | null }
  | {
    kind: 'verdict'
    risk: Risk | null
    riskColor: UiColor
    recommendation: Recommendation
    recommendationColor: UiColor
    confidence: string
    reasons: string[]
    rule: { floor: RuleFloor; reasons: string[] } | null
    /** C2: "run tainted · flagged content" — the run had read untrusted content when judged. */
    taint: string | null
  }

/** The card's judge section, or null when there is nothing to show (no judge / judge off). */
export function verdictView(judge: ApprovalVerdictDTO | null | undefined): VerdictView | null {
  if (!judge) return null
  const rule = judge.rule && floorShown(judge.rule.floor) ? { floor: judge.rule.floor, reasons: judge.rule.reasons } : null
  const taint = taintLabel(judge.taint)
  const v = judge.verdict
  if (!v) return judge.pending ? { kind: 'pending', autoPossible: judge.autoPossible, rule, taint } : null
  if (v.error) return { kind: 'error', error: v.error, rule, taint }
  return {
    kind: 'verdict',
    risk: v.risk,
    riskColor: riskColor(v.risk),
    recommendation: v.recommendation,
    recommendationColor: recommendationColor(v.recommendation),
    confidence: formatConfidence(v.confidence),
    reasons: v.reasons,
    rule,
    taint
  }
}

const TAINT_LABELS: Record<TaintSource, string> = {
  flagged: 'flagged content',
  mail: 'mail read',
  child: 'tainted child output',
  workspace: 'tainted workspace',
  unverified: 'unchecked content'
}
const TAINT_ORDER: TaintSource[] = ['flagged', 'mail', 'child', 'workspace', 'unverified']

/** The card's "run tainted" chip text, or null for a clean run: "run tainted · flagged content, mail read". */
export function taintLabel(sources: readonly TaintSource[] | null | undefined): string | null {
  const known = TAINT_ORDER.filter(x => sources?.includes(x))
  if (!sources?.length) return null
  return known.length ? `run tainted · ${known.map(x => TAINT_LABELS[x]).join(', ')}` : 'run tainted'
}

/** What an auto-approved card flips to: "⚖ auto-approved (0.94)". */
export function autoApprovedLabel(note: Pick<ToolApprovalNote, 'confidence'>): string {
  return `⚖ auto-approved (${formatConfidence(note.confidence)})`
}

/** The thread note on the call's tool part: "⚖ auto-approved (0.94): <first reason>". Only a note
 *  the JUDGE decided counts — anything else is not an auto-approval. */
export function autoApprovalNote(note: ToolApprovalNote | null | undefined): string | null {
  if (!note || note.decidedBy !== 'judge') return null
  const reason = note.reason?.replace(/\s+/g, ' ').trim()
  return reason ? `${autoApprovedLabel(note)}: ${reason}` : autoApprovedLabel(note)
}

/** The guard's `data-output_warning` part for one tool call, or null. */
export function outputWarningFor(m: Pick<AgentUIMessage, 'parts'>, toolCallId: string): OutputWarningDTO | null {
  const part = m.parts.find(p => p.type === 'data-output_warning' && p.id === toolCallId)
  return part && part.type === 'data-output_warning' ? part.data : null
}

const SOURCE_LABELS: Record<GuardSource, string> = {
  web: 'web content',
  mail: 'mail / calendar content',
  workspace: 'workspace output',
  child: 'a child workstream'
}
export function guardSourceLabel(source: GuardSource): string {
  return SOURCE_LABELS[source] ?? source
}

/** Smart Approvals confidence (spec §2.3): 0.5–0.99. The inline error, or null when valid. */
export function judgeConfidenceError(value: unknown): string | null {
  const n = typeof value === 'string' ? (value.trim() === '' ? Number.NaN : Number(value)) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'Enter a number'
  if (n < JUDGE_CONFIDENCE_LIMITS.min || n > JUDGE_CONFIDENCE_LIMITS.max) {
    return `Must be between ${JUDGE_CONFIDENCE_LIMITS.min} and ${JUDGE_CONFIDENCE_LIMITS.max}`
  }
  return null
}
