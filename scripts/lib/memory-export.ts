/**
 * Pure helpers for `pnpm memory:export` (scripts/memory-export.ts): turn memory rows plus
 * Tony's hand labels into the analysis rows of spec §7, and render them as CSV / JSONL.
 * No I/O here, so the shaping is unit-tested (test/memory-export.test.ts).
 */
import type { Label } from './labelling'

/** One memory as the export query returns it (snake_case, straight from Postgres). */
export interface MemoryScoreRow {
  id: string
  content: string
  scope: string
  project: string | null
  created_at: Date | string
  confidence: number | null
  extract_prompt_version: string | null
  audit_keep: number | null
  audit_verdict: string | null
  audit_reason: string | null
  audit_model: string | null
  audit_prompt_version: string | null
  audited_at: Date | string | null
  audit_failures: number
  jev_score: number | null
  jev_answers: unknown
  jev_model: string | null
  jev_scored_at: Date | string | null
  jev_failures: number
  archived_at: Date | string | null
  reviewed_at: Date | string | null
}

export interface ExportRow {
  id: string
  content: string
  scope: string
  project: string | null
  created_at: string
  extraction_confidence: number | null
  extract_prompt_version: string | null
  audit_keep: number | null
  audit_verdict: string | null
  audit_reason: string | null
  audit_model: string | null
  audit_prompt_version: string | null
  audit_failures: number
  jev_keep: number | null
  jev_answers: unknown
  jev_model: string | null
  jev_failures: number
  /** |audit_keep − jev_keep|, rounded to 6 decimals; null unless both scores exist. */
  disagreement: number | null
  archived: boolean
  reviewed: boolean
  label_verdict: string | null
  label_value: number | null
  label_durable: boolean | null
  label_self_contained: boolean | null
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

/**
 * Merge label files into one map by memory id. Files are passed in order (oldest first) and
 * lines are append-order within a file, so a later label for the same id wins — the labeller is
 * append-only, so a re-label is a later line.
 */
export function mergeLabels(files: Label[][]): Map<string, Label> {
  const out = new Map<string, Label>()
  for (const labels of files) for (const l of labels) if (l?.id) out.set(l.id, l)
  return out
}

export function toExportRow(m: MemoryScoreRow, labels: Map<string, Label>): ExportRow {
  const l = labels.get(m.id)
  const disagreement = m.audit_keep != null && m.jev_score != null
    ? Math.round(Math.abs(m.audit_keep - m.jev_score) * 1e6) / 1e6
    : null
  return {
    id: m.id,
    content: m.content,
    scope: m.scope,
    project: m.project,
    created_at: iso(m.created_at)!,
    extraction_confidence: m.confidence,
    extract_prompt_version: m.extract_prompt_version,
    audit_keep: m.audit_keep,
    audit_verdict: m.audit_verdict,
    audit_reason: m.audit_reason,
    audit_model: m.audit_model,
    audit_prompt_version: m.audit_prompt_version,
    audit_failures: m.audit_failures,
    jev_keep: m.jev_score,
    jev_answers: m.jev_answers ?? null,
    jev_model: m.jev_model,
    jev_failures: m.jev_failures,
    disagreement,
    archived: m.archived_at != null,
    reviewed: m.reviewed_at != null,
    label_verdict: l?.verdict ?? null,
    label_value: l?.value ?? null,
    label_durable: l?.durable ?? null,
    label_self_contained: l?.selfContained ?? null
  }
}

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF; objects become JSON. */
export function csvField(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const EXPORT_COLUMNS: (keyof ExportRow)[] = [
  'id', 'content', 'scope', 'project', 'created_at',
  'extraction_confidence', 'extract_prompt_version',
  'audit_keep', 'audit_verdict', 'audit_reason', 'audit_model', 'audit_prompt_version', 'audit_failures',
  'jev_keep', 'jev_answers', 'jev_model', 'jev_failures',
  'disagreement', 'archived', 'reviewed',
  'label_verdict', 'label_value', 'label_durable', 'label_self_contained'
]

export function toCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(',')]
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(c => csvField(r[c])).join(','))
  return lines.join('\n') + '\n'
}

export function toJsonl(rows: ExportRow[]): string {
  return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}
