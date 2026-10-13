// Cycle 85 Task 4 (spec §3.5): the /evals dashboard's pure logic — the expected-vs-actual tool-log
// alignment, run progress, run-vs-run deltas, the sparkline geometry and the case editor's form ⇄
// JSON round trip. Kept out of the .vue files so it is unit-tested.
import { EvalCaseJsonSchema, MATCH_MODES, type EvalCaseJson } from '@mymind/core/lib/eval/case-schema'
import type {
  EvalAttemptScoring, EvalMatchMode, EvalRunDTO, EvalRunStatus, EvalToolLogEntry
} from '@mymind/core/shared/types/eval'

export { MATCH_MODES }

type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export const RUN_STATUS_META: Record<EvalRunStatus, { label: string, color: BadgeColor, icon: string }> = {
  queued: { label: 'Queued', color: 'neutral', icon: 'i-lucide-clock' },
  running: { label: 'Running', color: 'info', icon: 'i-lucide-loader-circle' },
  done: { label: 'Done', color: 'success', icon: 'i-lucide-check' },
  failed: { label: 'Failed', color: 'error', icon: 'i-lucide-x' },
  cancelled: { label: 'Cancelled', color: 'neutral', icon: 'i-lucide-ban' }
}

export function isLive(status: EvalRunStatus): boolean { return status === 'queued' || status === 'running' }

/** 0.875 → "88%", null → "—". */
export function pct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`
}
export function score(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2)
}
export function signed(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s
}

/** Attempts done / planned (planned unknown until the run has selected its cases). */
export function runProgress(run: Pick<EvalRunDTO, 'status' | 'summary'>): { done: number, planned: number | null, ratio: number | null } {
  const done = run.summary?.attempts ?? 0
  const planned = run.summary?.planned ?? null
  return { done, planned, ratio: planned ? Math.min(1, done / planned) : null }
}

// ── The tool log, expected vs actual ─────────────────────────────────────────────────────────────

export interface ActionSpecLike { tool: string, args?: Record<string, unknown>, args_pattern?: Record<string, string> }

export type AlignedKind = 'matched' | 'missing' | 'unused' | 'extra'

export interface AlignedRow {
  kind: AlignedKind
  /** Index into the case's expected_actions (matched / missing / unused). */
  expected: number | null
  expectedSpec: ActionSpecLike | null
  /** Index into the tool log (matched / extra). */
  call: number | null
  entry: EvalToolLogEntry | null
  /** Forbidden specs this call hit (indexes into forbidden_actions). */
  forbidden: number[]
  /** The call was denied or errored (it only satisfies an expected action under count_failed). */
  failed: boolean
}

/**
 * Lines the tool log up against the case's expected actions using the scorer's own alignment
 * (`scoring.matched`): calls in order; each matched call sits beside its expected action; an
 * expected action no call met is a `missing` row placed before the first later match (or at the
 * end); a call no expected action used is `extra`. Under `contains_any` one match is enough, so
 * the others are `unused`, not missing. A call that hit a forbidden spec carries its indexes
 * whatever its kind.
 */
export function alignToolLog(
  expected: ActionSpecLike[],
  toolLog: EvalToolLogEntry[],
  scoring: Pick<EvalAttemptScoring, 'mode' | 'matched' | 'forbidden'> | null | undefined
): AlignedRow[] {
  const byCall = new Map<number, number>()
  for (const m of scoring?.matched ?? []) if (m.call >= 0 && m.call < toolLog.length && m.expected >= 0 && m.expected < expected.length) byCall.set(m.call, m.expected)
  const matchedExpected = new Set(byCall.values())
  const forbiddenByCall = new Map<number, number[]>()
  for (const f of scoring?.forbidden ?? []) forbiddenByCall.set(f.call, [...(forbiddenByCall.get(f.call) ?? []), f.forbidden])
  const missingKind: AlignedKind = scoring?.mode === 'contains_any' && matchedExpected.size > 0 ? 'unused' : 'missing'
  const emitted = new Set<number>()
  const rows: AlignedRow[] = []
  const missingRow = (e: number): AlignedRow => ({ kind: missingKind, expected: e, expectedSpec: expected[e] ?? null, call: null, entry: null, forbidden: [], failed: false })
  toolLog.forEach((entry, c) => {
    const e = byCall.get(c)
    const failed = entry.status === 'error' || entry.status === 'denied'
    const forbidden = forbiddenByCall.get(c) ?? []
    if (e === undefined) {
      rows.push({ kind: 'extra', expected: null, expectedSpec: null, call: c, entry, forbidden, failed })
      return
    }
    for (let u = 0; u < e; u++) {
      if (!matchedExpected.has(u) && !emitted.has(u)) { rows.push(missingRow(u)); emitted.add(u) }
    }
    rows.push({ kind: 'matched', expected: e, expectedSpec: expected[e] ?? null, call: c, entry, forbidden, failed })
    emitted.add(e)
  })
  expected.forEach((_, u) => { if (!matchedExpected.has(u) && !emitted.has(u)) rows.push(missingRow(u)) })
  return rows
}

/** An action spec as one readable line: `create_task(title="x", due~/fri/)`. */
export function specLabel(s: ActionSpecLike): string {
  const parts = [
    ...Object.entries(s.args ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    ...Object.entries(s.args_pattern ?? {}).map(([k, v]) => `${k}~/${v}/`)
  ]
  return parts.length ? `${s.tool}(${parts.join(', ')})` : s.tool
}

// ── Compare two runs ──────────────────────────────────────────────────────────────────────────

export type CaseChange = 'fixed' | 'regressed' | 'better' | 'worse' | 'same' | 'added' | 'removed'

export interface CompareRow {
  slug: string
  holdout: boolean
  a: { mean: number | null, passed: boolean, attempts: number } | null
  b: { mean: number | null, passed: boolean, attempts: number } | null
  /** b − a mean score (null when either side lacks one). */
  delta: number | null
  change: CaseChange
  /** The case's assembled system prompt differs between the runs. */
  promptChanged: boolean
}

export interface ProvenanceRow { field: string, a: string | null, b: string | null, same: boolean }

export interface RunComparison {
  cases: CompareRow[]
  provenance: ProvenanceRow[]
  nonHoldout: { a: number | null, b: number | null, delta: number | null }
  meanScore: { a: number | null, b: number | null, delta: number | null }
}

const EPS = 1e-9
const diff = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? null : b - a)

export function compareRuns(a: EvalRunDTO, b: EvalRunDTO): RunComparison {
  const sa = new Map((a.summary?.cases ?? []).map(c => [c.slug, c]))
  const sb = new Map((b.summary?.cases ?? []).map(c => [c.slug, c]))
  const ha = a.summary?.promptHashes ?? {}
  const hb = b.summary?.promptHashes ?? {}
  const slugs = [...new Set([...sa.keys(), ...sb.keys()])].sort()
  const cases: CompareRow[] = slugs.map((slug) => {
    const x = sa.get(slug)
    const y = sb.get(slug)
    const delta = diff(x?.meanScore, y?.meanScore)
    let change: CaseChange
    if (!x) change = 'added'
    else if (!y) change = 'removed'
    else if (!x.passed && y.passed) change = 'fixed'
    else if (x.passed && !y.passed) change = 'regressed'
    else if (delta !== null && delta > EPS) change = 'better'
    else if (delta !== null && delta < -EPS) change = 'worse'
    else change = 'same'
    return {
      slug,
      holdout: (y ?? x)!.holdout,
      a: x ? { mean: x.meanScore, passed: x.passed, attempts: x.attempts } : null,
      b: y ? { mean: y.meanScore, passed: y.passed, attempts: y.attempts } : null,
      delta,
      change,
      promptChanged: !!(ha[slug] && hb[slug] && ha[slug] !== hb[slug])
    }
  })
  const field = (name: string, x: string | null, y: string | null): ProvenanceRow => ({ field: name, a: x, b: y, same: x === y })
  return {
    cases,
    provenance: [
      field('Git SHA', a.gitSha, b.gitSha),
      field('Model', a.modelLabel, b.modelLabel),
      field('Prompt hash', a.promptHash, b.promptHash),
      field('Tools hash', a.toolsHash, b.toolsHash)
    ],
    nonHoldout: { a: a.summary?.nonHoldout.passRate ?? null, b: b.summary?.nonHoldout.passRate ?? null, delta: diff(a.summary?.nonHoldout.passRate, b.summary?.nonHoldout.passRate) },
    meanScore: { a: a.summary?.nonHoldout.meanScore ?? null, b: b.summary?.nonHoldout.meanScore ?? null, delta: diff(a.summary?.nonHoldout.meanScore, b.summary?.nonHoldout.meanScore) }
  }
}

export const CHANGE_META: Record<CaseChange, { label: string, color: BadgeColor }> = {
  fixed: { label: 'fixed', color: 'success' },
  better: { label: 'better', color: 'success' },
  regressed: { label: 'regressed', color: 'error' },
  worse: { label: 'worse', color: 'warning' },
  same: { label: 'same', color: 'neutral' },
  added: { label: 'only in B', color: 'info' },
  removed: { label: 'only in A', color: 'info' }
}

// ── Sparkline ──────────────────────────────────────────────────────────────────────────────────

/** SVG polyline points for values in [0, 1] (nulls skipped), left→right across `w`, 0 at the bottom. */
export function sparkPoints(values: Array<number | null>, w: number, h: number, pad = 2): string {
  const n = values.length
  if (!n) return ''
  const step = n > 1 ? (w - 2 * pad) / (n - 1) : 0
  const out: string[] = []
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return
    const x = n > 1 ? pad + i * step : w / 2
    const y = pad + (1 - Math.max(0, Math.min(1, v))) * (h - 2 * pad)
    out.push(`${round(x)},${round(y)}`)
  })
  return out.join(' ')
}
const round = (v: number) => Math.round(v * 10) / 10

// ── Case editor: form ⇄ JSON ────────────────────────────────────────────────────────────────

/** One action row in the form: the tool plus its args / args_pattern as JSON text. */
export interface ActionRow { tool: string, args: string, argsPattern: string }

export interface CaseForm {
  slug: string
  prompt: string
  surface: 'chat' | 'workstream'
  matchMode: EvalMatchMode
  rubric: string
  nRuns: number
  maxSteps: number
  holdout: boolean
  enabled: boolean
  expectFlagged: boolean
  expectTainted: boolean
  countFailed: boolean
  /** One regex per line. */
  expectedContent: string
  expectedActions: ActionRow[]
  forbiddenActions: ActionRow[]
  /** Comma-separated tool names. */
  expectedApprovals: string
  forbiddenApprovals: string
  /** Kept as-is (edited in the JSON tab). */
  setup: Record<string, unknown>
}

export interface FieldIssue { path: Array<string | number>, message: string }

const toRow = (s: ActionSpecLike): ActionRow => ({
  tool: s.tool,
  args: s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : '',
  argsPattern: s.args_pattern && Object.keys(s.args_pattern).length ? JSON.stringify(s.args_pattern) : ''
})

export function toForm(c: EvalCaseJson): CaseForm {
  return {
    slug: c.slug, prompt: c.prompt, surface: c.surface, matchMode: c.match_mode, rubric: c.rubric ?? '',
    nRuns: c.n_runs, maxSteps: c.max_steps, holdout: c.holdout, enabled: c.enabled,
    expectFlagged: c.expect_flagged, expectTainted: c.expect_tainted, countFailed: c.count_failed,
    expectedContent: c.expected_content.join('\n'),
    expectedActions: c.expected_actions.map(toRow), forbiddenActions: c.forbidden_actions.map(toRow),
    expectedApprovals: c.expected_approvals.map(a => a.tool).join(', '),
    forbiddenApprovals: c.forbidden_approvals.map(a => a.tool).join(', '),
    setup: (c.setup ?? {}) as Record<string, unknown>
  }
}

const tools = (s: string) => s.split(',').map(t => t.trim()).filter(Boolean).map(tool => ({ tool }))

/** The form as case JSON, validated by the import schema. Issues carry JSON paths (e.g.
 *  ['expected_actions', 1, 'args']) so the form pins each to its field. */
export function fromForm(f: CaseForm): { json: EvalCaseJson | null, raw: Record<string, unknown>, issues: FieldIssue[] } {
  const issues: FieldIssue[] = []
  const actions = (rows: ActionRow[], key: 'expected_actions' | 'forbidden_actions') => rows.map((r, i) => {
    const out: Record<string, unknown> = { tool: r.tool.trim() }
    for (const [field, text] of [['args', r.args], ['args_pattern', r.argsPattern]] as const) {
      if (!text.trim()) continue
      try {
        const v = JSON.parse(text)
        if (!v || typeof v !== 'object' || Array.isArray(v)) issues.push({ path: [key, i, field], message: 'must be a JSON object, e.g. {"title": "x"}' })
        else out[field] = v
      } catch (e) {
        issues.push({ path: [key, i, field], message: `not valid JSON: ${(e as Error).message}` })
      }
    }
    return out
  })
  const raw: Record<string, unknown> = {
    slug: f.slug.trim(), prompt: f.prompt, surface: f.surface, setup: f.setup,
    expected_actions: actions(f.expectedActions, 'expected_actions'),
    forbidden_actions: actions(f.forbiddenActions, 'forbidden_actions'),
    expected_content: f.expectedContent.split('\n').map(s => s.trim()).filter(Boolean),
    match_mode: f.matchMode, rubric: f.rubric.trim() ? f.rubric.trim() : null,
    n_runs: Number(f.nRuns), max_steps: Number(f.maxSteps), holdout: f.holdout, enabled: f.enabled,
    expect_flagged: f.expectFlagged, expect_tainted: f.expectTainted,
    expected_approvals: tools(f.expectedApprovals), forbidden_approvals: tools(f.forbiddenApprovals),
    count_failed: f.countFailed
  }
  const parsed = EvalCaseJsonSchema.safeParse(raw)
  if (!parsed.success) for (const i of parsed.error.issues) issues.push({ path: i.path.map(p => (typeof p === 'symbol' ? String(p) : p)), message: i.message })
  return { json: parsed.success && !issues.length ? parsed.data : null, raw, issues }
}

/** The JSON tab's text, parsed and validated. A syntax error is one root issue with its position. */
export function parseCaseText(text: string): { json: EvalCaseJson | null, issues: FieldIssue[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { json: null, issues: [{ path: [], message: `not valid JSON: ${(e as Error).message}` }] }
  }
  const parsed = EvalCaseJsonSchema.safeParse(raw)
  if (parsed.success) return { json: parsed.data, issues: [] }
  return { json: null, issues: parsed.error.issues.map(i => ({ path: i.path.map(p => (typeof p === 'symbol' ? String(p) : p)), message: i.message })) }
}

/** The issues whose path starts with `prefix`, as one line for a UFormField `error` (undefined = none). */
export function issueAt(issues: FieldIssue[], ...prefix: Array<string | number>): string | undefined {
  const hit = issues.filter(i => prefix.every((p, k) => i.path[k] === p))
  return hit.length ? hit.map(i => i.message).join('; ') : undefined
}

export function pathLabel(path: Array<string | number>): string {
  return path.length ? path.map(p => (typeof p === 'number' ? `[${p}]` : p)).join('.').replace(/\.\[/g, '[') : '(whole case)'
}
