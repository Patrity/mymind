/**
 * Pure helpers for showing a memory's scores (cycle 77): the extraction `confidence`, Jev's
 * independent read, and the extract-v3 LLM audit. All three share one orientation (higher =
 * keep), so one set of colour bands serves them all.
 *
 * Colour is a nudge, not a verdict — Jev's calibration (n=28) supports ORDERING, not deciding,
 * so the bands are deliberately coarse and never red/green "right/wrong".
 */
import type { AuditVerdict } from '~~/shared/types/memory'

/** |audit − Jev| at or above this is a "disagree" (spec D4). Mirrors the SQL filter in listMemories. */
export const DISAGREE_THRESHOLD = 0.4

type Score = number | null | undefined

/** The /review bands: < 0.4 warning, < 0.6 muted, else success; unscored is dimmed. */
export function scoreColor(score: Score): string {
  if (score == null) return 'text-dimmed'
  if (score < 0.4) return 'text-warning'
  if (score < 0.6) return 'text-muted'
  return 'text-success'
}

export function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

export function jevTooltip(score: Score, answers?: Record<string, number> | null): string {
  if (score == null) return 'Not scored yet'
  const read = score < 0.4 ? 'likely transient or easily re-derived' : score < 0.6 ? 'mixed' : 'specific and durable'
  const base = `Jev's independent read: ${pct(score)} — ${read}. Advisory; it orders, it does not decide.`
  const raw = answers ? Object.entries(answers).map(([k, v]) => `${k} ${pct(v)}`).join(', ') : ''
  return raw ? `${base} Answers: ${raw}.` : base
}

/** Exhaustive over AuditVerdict, so a new verdict is a type error here. */
export const VERDICT_LABELS: Record<AuditVerdict, string> = {
  keep: 'keep',
  transient: 'transient',
  redundant: 'redundant',
  wrong_scope: 'wrong scope',
  belongs_in_doc: 'belongs in a doc'
}

export function verdictColor(verdict: AuditVerdict | null | undefined): 'success' | 'warning' | 'neutral' {
  if (!verdict) return 'neutral'
  return verdict === 'keep' ? 'success' : 'warning'
}

export function auditTooltip(keep: Score, verdict: AuditVerdict | null | undefined, reason: string | null | undefined): string {
  if (keep == null) return 'Not audited yet'
  const v = verdict ? ` — ${VERDICT_LABELS[verdict]}` : ''
  const r = reason ? `: ${reason.trim().replace(/[.\s]+$/, '')}` : ''
  return `LLM audit (extract-v3 criteria): ${pct(keep)}${v}${r}. Advisory; it never changes the memory.`
}

/**
 * |a − b|, or null when either side is missing — a single score is never a disagreement of 0
 * (Review Focus 5). Rounded to 6 decimals so 0.7 vs 0.3 is exactly 0.4, as in the SQL filter
 * (which compares the float4 columns cast to numeric).
 */
export function disagreement(a: Score, b: Score): number | null {
  if (a == null || b == null) return null
  return Math.round(Math.abs(a - b) * 1e6) / 1e6
}

export function isDisagreement(a: Score, b: Score): boolean {
  const d = disagreement(a, b)
  return d != null && d >= DISAGREE_THRESHOLD
}
