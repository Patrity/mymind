// Cycle 81 (spec §3.1): the run-event log — the worker's hub writes here, the web reads it.
//
// One writer per run. `emit` is synchronous and never throws (a run must not die because the
// bus hiccupped); rows go out in emit order, in batches:
//   - consecutive text/reasoning deltas of the same part (same turn, same chunk id, same
//     targeting) merge into ONE row with the concatenated delta, flushed ≤ coalesceMs after the
//     first of them was emitted;
//   - any other frame flushes on the next macrotask (it is a state change the UI should see
//     now), carrying any delta buffered before it, in order.
// After each batch commits: `NOTIFY run_event, '<conversation_id>:<last id>'` — a pointer; the
// reader fetches rows after its own cursor, so one notify per batch is enough.
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { runEvents } from '../../db/schema'
import type { AgentMessageFrame } from '../../shared/types/agent-ui'

/** Today's hub frames minus audio (spec §3.1) — what the runner and ws.ts publish to a
 *  conversation's sockets. Audio (`audio-begin`/PCM/`audio-end`) never crosses the bus: TTS runs
 *  in the web process (spec §4). */
export type HubFrame =
  | AgentMessageFrame
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }
  | { type: 'conversation'; conversationId: string; title: string | null }
  | { type: 'persisted'; conversationId: string }
  | { type: 'error'; message: string }
  | { type: 'approval'; requestId: string; tool: string; command: string; proposedPattern: string; allowlistable: boolean; title?: string }
  | { type: 'approval-resolved'; requestId: string }

export type RunEventRow = typeof runEvents.$inferSelect

export interface RunEventWriter {
  /** Queue a frame; `only` targets one sink (origin-socket frames). Never throws. */
  emit(frame: HubFrame, only?: string | null): void
  /** Resolves once everything emitted so far is committed and notified. */
  flush(): Promise<void>
  /** Flush, then ignore further emits. */
  close(): Promise<void>
}

export const DEFAULT_COALESCE_MS = 50

interface Pending { frame: HubFrame; only: string | null }

type DeltaChunk = { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string }
function deltaOf(f: HubFrame): DeltaChunk | null {
  if (f.type !== 'chunk') return null
  const c = f.chunk as { type: string }
  return c.type === 'text-delta' || c.type === 'reasoning-delta' ? (f.chunk as DeltaChunk) : null
}

/** Folds `next` into `last` when both are deltas of the same part with the same targeting. */
export function tryMerge(last: Pending | undefined, next: Pending): boolean {
  if (!last || last.only !== next.only) return false
  const a = deltaOf(last.frame)
  const b = deltaOf(next.frame)
  if (!a || !b || a.type !== b.type || a.id !== b.id) return false
  if ((last.frame as { turnId: number }).turnId !== (next.frame as { turnId: number }).turnId) return false
  last.frame = { ...last.frame, chunk: { ...a, delta: a.delta + b.delta } } as HubFrame
  return true
}

export function createRunEventWriter(runId: string, conversationId: string, opts: { coalesceMs?: number } = {}): RunEventWriter {
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS
  let pending: Pending[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let urgent = false
  let closed = false
  let seq: number | null = null
  // Batches commit strictly in order: seq allocation and insert order must match emit order.
  let chain: Promise<void> = Promise.resolve()

  const writeBatch = async (batch: Pending[]) => {
    const db = useDb()
    if (seq === null) {
      // A run's writer may be re-created (worker restart mid-run): continue its numbering.
      const [r] = await db.select({ max: sql<number | null>`max(${runEvents.seq})` }).from(runEvents).where(eq(runEvents.runId, runId))
      seq = Number(r?.max ?? 0)
    }
    const base = seq
    const rows = batch.map((p, i) => ({
      runId,
      conversationId,
      seq: base + i + 1,
      type: p.frame.type,
      payload: p.frame,
      onlySink: p.only
    }))
    const inserted = await db.insert(runEvents).values(rows).returning({ id: runEvents.id })
    seq = base + batch.length
    const lastId = Math.max(...inserted.map(r => r.id))
    await db.execute(sql`select pg_notify('run_event', ${`${conversationId}:${lastId}`})`)
  }

  const kick = () => {
    if (timer) { clearTimeout(timer); timer = null }
    urgent = false
    const batch = pending
    pending = []
    if (!batch.length) return chain
    chain = chain.then(() => writeBatch(batch)).catch((err) => {
      // The frames are lost to the log, but the run goes on; a reader will see a seq gap only
      // if a later batch succeeds with a re-read seq — reset so it re-reads.
      seq = null
      console.error(`[bus] run_events write failed (run ${runId}, ${batch.length} frames)`, err)
    })
    return chain
  }

  return {
    emit(frame, only = null) {
      if (closed) return
      const p: Pending = { frame, only: only ?? null }
      const isDelta = !!deltaOf(frame)
      if (!(isDelta && tryMerge(pending[pending.length - 1], p))) pending.push(p)
      if (!isDelta) {
        if (!urgent) {
          urgent = true
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => { void kick() }, 0)
        }
      } else if (!timer) {
        timer = setTimeout(() => { void kick() }, coalesceMs)
      }
    },
    flush() { return kick() },
    async close() {
      closed = true
      await kick()
    }
  }
}

/** Rows of the log in id order. Scope by conversation and/or run; resume after `afterId` (the
 *  last row a reader saw) or, within one run, after `afterSeq`. */
export async function readRunEvents(q: { conversationId?: string; runId?: string; afterId?: number; afterSeq?: number; limit?: number }): Promise<RunEventRow[]> {
  if (!q.conversationId && !q.runId) throw new Error('readRunEvents needs conversationId or runId')
  if (q.afterSeq !== undefined && !q.runId) throw new Error('readRunEvents: afterSeq needs runId')
  const where = and(
    q.conversationId ? eq(runEvents.conversationId, q.conversationId) : undefined,
    q.runId ? eq(runEvents.runId, q.runId) : undefined,
    q.afterId !== undefined ? gt(runEvents.id, q.afterId) : undefined,
    q.afterSeq !== undefined ? gt(runEvents.seq, q.afterSeq) : undefined
  )
  return useDb().select().from(runEvents).where(where).orderBy(asc(runEvents.id)).limit(q.limit ?? 500)
}

/** Parses a `run_event` NOTIFY payload (`'<conversation_id>:<id>'`). */
export function parseRunEventNotify(payload: string): { conversationId: string; id: number } | null {
  const i = payload.lastIndexOf(':')
  if (i <= 0) return null
  const id = Number(payload.slice(i + 1))
  return Number.isSafeInteger(id) ? { conversationId: payload.slice(0, i), id } : null
}
