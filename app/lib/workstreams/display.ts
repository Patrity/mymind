// Cycle 81 Task 6: pure display helpers for workstreams (spec §5.5) — kept out of the SFCs so the
// labels, the budget maths and the event parsing are unit-tested.
import {
  BUDGET_LIMITS, resumeBudget,
  type WorkstreamBudget, type WorkstreamDTO, type WorkstreamState, type WorkstreamUsed
} from '@mymind/core/shared/types/workstreams'
import { splitOrigin } from '@mymind/core/shared/utils/event-origin'

type Color = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export const STATE_META: Record<WorkstreamState, { label: string; color: Color; icon: string }> = {
  queued: { label: 'queued', color: 'neutral', icon: 'i-lucide-clock' },
  running: { label: 'running', color: 'info', icon: 'i-lucide-loader' },
  attention: { label: 'needs you', color: 'warning', icon: 'i-lucide-hand' },
  paused: { label: 'paused', color: 'neutral', icon: 'i-lucide-pause' },
  done: { label: 'done', color: 'success', icon: 'i-lucide-circle-check' },
  failed: { label: 'failed', color: 'error', icon: 'i-lucide-circle-x' },
  cancelled: { label: 'cancelled', color: 'neutral', icon: 'i-lucide-ban' }
}

export function isTerminal(state: WorkstreamState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}
export function canCancel(state: WorkstreamState): boolean { return !isTerminal(state) }
/** Resume restarts a failed/cancelled one, continues a paused one, or one waiting on Tony without an answer. */
export function canResume(state: WorkstreamState): boolean { return state === 'failed' || state === 'cancelled' || state === 'attention' || state === 'paused' }

/** "45s", "12m", "1h 05m" — compact, for tables and meters. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function formatCost(usd: number): string {
  if (!usd) return '$0'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/** Wall-clock since it was created (to its finish, or now) — the list's "elapsed". */
export function elapsedMs(ws: Pick<WorkstreamDTO, 'createdAt' | 'finishedAt'>, now: number): number {
  return (ws.finishedAt ? Date.parse(ws.finishedAt) : now) - Date.parse(ws.createdAt)
}

export function isExhausted(budget: WorkstreamBudget, used: WorkstreamUsed): boolean {
  return used.steps >= budget.maxSteps || used.wallMs >= budget.maxWallMs
}

/**
 * How much more room Resume gives a failed/cancelled workstream whose budget is used up — the loop's own rule
 * (`resumeBudget` + the BUDGET_LIMITS clamp), so the button can say it before it is pressed.
 * Null when Resume adds nothing (budget left, or a state Resume does not reactivate).
 */
export function resumeAdds(ws: Pick<WorkstreamDTO, 'state' | 'budget' | 'used'>): { steps: number; minutes: number } | null {
  if (ws.state !== 'failed' && ws.state !== 'cancelled') return null
  if (!isExhausted(ws.budget, ws.used)) return null
  // In what is LEFT to work with, not in the limit: the final summary step can run one past the
  // budget, so a 2-step budget used as 3 becomes 43 — and that is 40 more steps of work.
  const next = resumeBudget(ws.budget, ws.used)
  const left = (max: number, used: number) => Math.max(0, max - used)
  const steps = left(Math.min(next.maxSteps, BUDGET_LIMITS.maxSteps.max), ws.used.steps) - left(ws.budget.maxSteps, ws.used.steps)
  const wall = left(Math.min(next.maxWallMs, BUDGET_LIMITS.maxWallMs.max), ws.used.wallMs) - left(ws.budget.maxWallMs, ws.used.wallMs)
  if (steps <= 0 && wall <= 0) return null
  return { steps: Math.max(0, steps), minutes: Math.max(0, Math.round(wall / 60_000)) }
}

export function resumeLabel(ws: Pick<WorkstreamDTO, 'state' | 'budget' | 'used'>): string {
  const add = resumeAdds(ws)
  if (!add) return 'Resume'
  const parts = [add.steps ? `+${add.steps} steps` : '', add.minutes ? `+${add.minutes} min` : ''].filter(Boolean)
  return `Resume (${parts.join(', ')})`
}

/** Tooltip copy for the budget meter: what is and is not counted (Task 5 decisions). */
export const BUDGET_NOTES = {
  wall: 'Active time only: time a segment is actually working. Waiting for you, waiting in the queue and the agent worker being down do not count.',
  steps: 'Model steps of the workstream itself. Steps and cost of sub-agents it calls (research_web, search_brain) are not counted.'
} as const

// ── Event rows ────────────────────────────────────────────────────────────────────────────────

const SEGMENT_LABELS: Record<string, { label: string; icon: string }> = {
  'start': { label: 'Started', icon: 'i-lucide-play' },
  'continue': { label: 'Next segment', icon: 'i-lucide-step-forward' },
  'restarted': { label: 'Agent worker restarted — resumed from the log', icon: 'i-lucide-rotate-cw' },
  'retry': { label: 'The previous segment failed — retrying', icon: 'i-lucide-refresh-ccw' },
  'idle': { label: 'No tool calls last segment — asked to finish or keep going', icon: 'i-lucide-pause' },
  'budget': { label: 'Budget used up — writing the final summary', icon: 'i-lucide-gauge' },
  'approval-lost': { label: 'Restarted while waiting for approval — that action did not run; it will ask again', icon: 'i-lucide-shield-off' }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type EventDisplay =
  | { kind: 'divider'; label: string; icon: string }
  | { kind: 'workstream'; workstreamId: string; tone: Color; icon: string; title: string; body: string }
  /** Cycle 83: a child's state-only lifecycle note in its coordinator's thread (a compact row). */
  | { kind: 'lifecycle'; workstreamId: string; tone: Color; icon: string; goal: string; label: string }
  /** Cycle 83: a `segment:children` report (the wake prompt, or one steered into a running segment).
   *  Its body holds text CHILD runs wrote — untrusted; rendered only as escaped plain text. */
  | { kind: 'report'; title: string; body: string }

/** The coordinator's lifecycle notes (coordinator.ts noteText): `Child workstream "<goal>" (id <id>) <what>`. */
const LIFECYCLE: Array<{ test: (rest: string) => boolean; label: string; tone: Color; icon: string }> = [
  { test: r => r === 'was spawned.', label: 'spawned', tone: 'info', icon: 'i-lucide-git-branch-plus' },
  { test: r => r === 'finished.', label: 'finished', tone: 'success', icon: 'i-lucide-circle-check' },
  { test: r => r === 'failed.', label: 'failed', tone: 'error', icon: 'i-lucide-circle-x' },
  { test: r => r === 'was cancelled.', label: 'cancelled', tone: 'neutral', icon: 'i-lucide-ban' },
  { test: r => r.startsWith('is asking you a question'), label: 'asks its coordinator a question', tone: 'warning', icon: 'i-lucide-message-circle-question' },
  { test: r => r.startsWith('is waiting for Tony'), label: 'waits for your approval', tone: 'warning', icon: 'i-lucide-shield-question' },
  { test: r => r === 'paused.', label: 'paused', tone: 'neutral', icon: 'i-lucide-pause' }
]

function lifecycleOf(id: string, text: string): Extract<EventDisplay, { kind: 'lifecycle' }> | null {
  const head = 'Child workstream "'
  const mark = `" (id ${id}) `
  const at = text.lastIndexOf(mark)
  if (!text.startsWith(head) || at < head.length) return null
  const rest = text.slice(at + mark.length).trim()
  const hit = LIFECYCLE.find(l => l.test(rest))
  if (!hit) return null
  return { kind: 'lifecycle', workstreamId: id, tone: hit.tone, icon: hit.icon, goal: text.slice(head.length, at), label: hit.label }
}

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * How an `event` row renders. `workstream:<id>` rows (start/finish/attention/answered notes posted
 * to the chat a workstream came from) become a card with its link; `segment:<why>` rows (a
 * workstream's own log) and `runtime:restart` become readable dividers; the rest keep the generic
 * "<kind>: <text>" divider.
 */
export function eventDisplay(origin: string | null | undefined, text: string): EventDisplay {
  const { kind, detail } = splitOrigin(origin)
  if (kind === 'workstream' && UUID_RE.test(detail)) {
    const life = lifecycleOf(detail, text)
    if (life) return life
    // The notifier appends the link as its own last line; the card has a button for it.
    const lines = text.split('\n')
    if (lines.at(-1)?.trim() === `/workstreams/${detail}`) lines.pop()
    const [head = '', ...rest] = lines
    // "answered ⚙ <goal>: <text>" (an iMessage reply routed into a waiting workstream) is one line.
    const answered = /^answered ⚙\s*/.exec(head)
    const title = answered ? 'Answered from iMessage' : head.replace(/^⚙\s*/, '').trim()
    const body = (answered ? [head.slice(answered[0].length), ...rest] : rest).join('\n').trim()
    const tone: Color = /^Workstream done/.test(title)
      ? 'success'
      : /^Workstream stopped/.test(title)
        ? 'error'
        : answered ? 'neutral' : 'warning'
    const icon = tone === 'success' ? 'i-lucide-circle-check' : tone === 'error' ? 'i-lucide-circle-x' : tone === 'neutral' ? 'i-lucide-reply' : 'i-lucide-hand'
    return { kind: 'workstream', workstreamId: detail, tone, icon, title, body }
  }
  if (kind === 'segment' && detail === 'children') {
    const [head = '', ...rest] = text.split('\n')
    return { kind: 'report', title: clip(head.trim() || 'Child reports', 120), body: rest.join('\n').replace(/^\n+|\s+$/g, '') }
  }
  if (kind === 'segment') {
    const s = SEGMENT_LABELS[detail]
    return s ? { kind: 'divider', label: s.label, icon: s.icon } : { kind: 'divider', label: `segment · ${detail}`, icon: 'i-lucide-step-forward' }
  }
  if (kind === 'runtime' && detail === 'restart') return { kind: 'divider', label: 'Interrupted by a restart', icon: 'i-lucide-rotate-cw' }
  const head = kind === 'wake' ? `woken · ${detail}` : kind === 'review' ? `review · ${detail}` : kind === 'runtime' ? 'runtime' : 'note'
  return { kind: 'divider', label: `${head}: ${clip(text)}`, icon: 'i-lucide-alarm-clock' }
}

/** The compact chat card for a `start_workstream` tool call that succeeded (its result carries the
 *  id; the goal is the call's own input). Null for any other tool or a refusal. */
export function startedWorkstream(toolName: string, input: unknown, output: unknown): { id: string; goal: string } | null {
  if (toolName !== 'start_workstream') return null
  let o = output as { ok?: boolean; id?: unknown } | string | null
  if (typeof o === 'string') {
    try { o = JSON.parse(o) as { ok?: boolean; id?: unknown } } catch { return null }
  }
  if (!o || typeof o !== 'object' || o.ok !== true || typeof o.id !== 'string' || !UUID_RE.test(o.id)) return null
  const goal = (input as { goal?: unknown } | null)?.goal
  return { id: o.id, goal: typeof goal === 'string' ? goal : '' }
}

// ── Coordinators (cycle 83, spec §6) ─────────────────────────────────────────────────────────

export type WorkstreamNode = WorkstreamDTO & { children?: WorkstreamNode[] }

/**
 * The /workstreams tree: children nested under their coordinator (oldest first, as `childIds`),
 * top-level rows in the order given. A child whose coordinator is not in the list (an orphan, or a
 * coordinator outside the page) stays a top-level row rather than disappearing.
 */
export function nestWorkstreams(rows: WorkstreamDTO[]): WorkstreamNode[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: WorkstreamNode[] = []
  for (const r of rows) {
    if (r.parentId && byId.has(r.parentId)) continue
    const kids = rows.filter(k => k.parentId === r.id)
      .sort((a, b) => (r.childIds.indexOf(a.id) + 1 || Infinity) - (r.childIds.indexOf(b.id) + 1 || Infinity))
    out.push(kids.length ? { ...r, children: kids } : r)
  }
  return out
}

/** A child's model as the panel shows it: its `subagents` label, or the default resolution. */
export function childModelLabel(ws: Pick<WorkstreamDTO, 'modelLabel'>): string {
  return ws.modelLabel ?? 'default model'
}

type Reservable = Pick<WorkstreamDTO, 'state' | 'budget' | 'used'>
/** What a tree member holds of its coordinator's tree budget — the core's `reservationOf`
 *  (coordinator.ts): a live one its budget (or more, if it ran over); an ended one only what it used. */
export function reservationOf(w: Reservable): { steps: number; wallMs: number } {
  if (isTerminal(w.state)) return { steps: w.used.steps, wallMs: w.used.wallMs }
  return { steps: Math.max(w.budget.maxSteps, w.used.steps), wallMs: Math.max(w.budget.maxWallMs, w.used.wallMs) }
}

/** Committed tree budget = the coordinator's own reservation (always as live) + every child's
 *  (the core's `committedOf`), so the meter shows what spawn would see. */
export function treeCommitted(coord: Reservable, kids: Reservable[]): { steps: number; wallMs: number } {
  const all = [reservationOf({ ...coord, state: 'running' }), ...kids.map(reservationOf)]
  return { steps: all.reduce((n, a) => n + a.steps, 0), wallMs: all.reduce((n, a) => n + a.wallMs, 0) }
}
