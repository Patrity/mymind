/**
 * Pure helpers for the memory hand-labelling harness (`scripts/label-memories.ts`).
 *
 * The labels this produces are the ground truth every Jev threshold gets fitted
 * against. Two properties matter more than anything else here:
 *
 *  1. **Blinding.** `blindRow` is the only way a row reaches the screen. The stored
 *     `confidence`, the `kind:` tag and the `review:*` flags are exactly what we are
 *     trying to validate — showing them would anchor the labeller on the thing under
 *     test and make the labels worthless.
 *  2. **Resumability.** Labelling 120 items is not one sitting. The output is
 *     append-only JSONL and `remaining` replays it, so a half-written final line
 *     (killed process) must never lose the work before it.
 */

export type Scope = 'user' | 'agent' | 'world'
export type Stratum = 'main' | 'booster'
export type Value = 0 | 1 | 2 | 3
export type Verdict = 'keep' | 'stale' | 'noise'

/** A row as pulled from prod — carries the hidden signals for later joining. */
export interface SampleRow {
  id: string
  stratum: Stratum
  scope: Scope
  content: string
  project: string | null
  source_date: string | null
  created_at: string
  confidence: number | null
  tags: string[]
  reviewed_at: string | null
  enriched_at: string | null
  session_id: string | null
}

/** The strict subset a labeller is allowed to see. */
export interface BlindedRow {
  id: string
  content: string
  scope: Scope
  project: string | null
  sourceDate: string
}

export interface Label {
  id: string
  value: Value
  durable: boolean
  selfContained: boolean
  verdict: Verdict
  labelledAt: string
}

/**
 * `noise` when the memory was never worth keeping; `stale` when it was true once
 * and no longer is. Keeping those distinct is the point — the staleness sweep
 * hunts confident, useful-sounding statements that have gone wrong, which are
 * worse than noise because agents act on them.
 */
export function deriveVerdict(value: Value, durable: boolean): Verdict {
  if (value === 0) return 'noise'
  return durable ? 'keep' : 'stale'
}

export function blindRow(row: SampleRow): BlindedRow {
  return {
    id: row.id,
    content: row.content,
    scope: row.scope,
    project: row.project,
    sourceDate: row.source_date ?? row.created_at
  }
}

export function formatLabelLine(label: Label): string {
  return JSON.stringify(label)
}

/** Tolerant by design: a truncated last line is dropped, never thrown on. */
export function parseLabels(text: string): Label[] {
  return text.split('\n').flatMap((line): Label[] => {
    const s = line.trim()
    if (!s) return []
    try {
      return [JSON.parse(s) as Label]
    } catch {
      return []
    }
  })
}

/** Sample rows still needing a label, in sample order. */
export function remaining(sample: SampleRow[], labels: Label[]): SampleRow[] {
  const done = new Set(labels.map(l => l.id))
  return sample.filter(r => !done.has(r.id))
}
