// Cycle 81 (spec §3.1): the run-event log — the worker's hub writes here, the web reads it.
//
// One writer per run. `emit` is synchronous and never throws (a run must not die because the
// bus hiccupped); rows go out in emit order, in batches:
//   - consecutive text/reasoning deltas of the same part (same turn, same chunk id, same
//     targeting) merge into ONE row with the concatenated delta, flushed ≤ coalesceMs after the
//     first of them was emitted;
//   - any other frame flushes on the next macrotask (it is a state change the UI should see
//     now), carrying any delta buffered before it, in order.
// Each batch is ONE transaction: rows + `NOTIFY run_event, '<ns>:<conversation_id>:<last id>'`
// (a pointer — the reader fetches rows after its own cursor, so one notify per batch is enough;
// listeners see `<conversation_id>:<last id>`, the ns is stripped by listen.ts). A failed batch is
// retried with backoff at the head of the chain (order preserved); one that fails every attempt
// is reported (onError + the next flush/close rejects) — never dropped silently.
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { runEvents } from '../../db/schema'
import type { AgentMessageFrame } from '../../shared/types/agent-ui'
import { notifySql } from './listen'
import { busNs } from './ns'

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

export type NewRunEventRow = typeof runEvents.$inferInsert

/** Where a writer's batches go. The default is Postgres; tests inject failures. `append` must be
 *  atomic (all rows + the notify, or nothing) — a retry re-sends the whole batch. */
export interface RunEventStore {
  maxSeq(runId: string): Promise<number>
  append(rows: NewRunEventRow[], conversationId: string): Promise<void>
}

export const dbRunEventStore: RunEventStore = {
  async maxSeq(runId) {
    const [r] = await useDb().select({ max: sql<number | null>`max(${runEvents.seq})` }).from(runEvents).where(eq(runEvents.runId, runId))
    return Number(r?.max ?? 0)
  },
  async append(rows, conversationId) {
    // One transaction: the NOTIFY is delivered on commit, so a reader woken by it always finds
    // the rows, and a failed attempt leaves nothing behind for the retry to duplicate.
    await useDb().transaction(async (tx) => {
      const inserted = await tx.insert(runEvents).values(rows).returning({ id: runEvents.id })
      const lastId = Math.max(...inserted.map(r => r.id))
      await tx.execute(notifySql('run_event', `${conversationId}:${lastId}`))
    })
  }
}

/** A batch that could not be written after every retry. The writer keeps going with later
 *  frames; the run sees this through `onError` and from the next `flush()` / `close()`. */
export class RunEventWriteError extends Error {
  readonly code = 'RUN_EVENT_WRITE_FAILED' as const
  constructor(readonly runId: string, readonly frameTypes: string[], readonly cause: unknown) {
    super(`run_events: lost ${frameTypes.length} frame(s) of run ${runId} (${[...new Set(frameTypes)].join(', ')}): ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'RunEventWriteError'
  }
}

export interface RunEventWriterOptions {
  coalesceMs?: number
  /** Attempts per batch (default 6) and the first backoff (default 100ms, doubling, ≤ 2s). */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number }
  /** Called once per batch that failed every attempt. */
  onError?: (err: RunEventWriteError) => void
  store?: RunEventStore
}

export function createRunEventWriter(runId: string, conversationId: string, opts: RunEventWriterOptions = {}): RunEventWriter {
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS
  const attempts = Math.max(1, opts.retry?.attempts ?? 6)
  const baseMs = opts.retry?.baseMs ?? 100
  const maxMs = opts.retry?.maxMs ?? 2_000
  const store = opts.store ?? dbRunEventStore
  const ns = busNs()
  let pending: Pending[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let urgent = false
  let closed = false
  let seq: number | null = null
  let failure: RunEventWriteError | null = null
  // Batches commit strictly in order: seq allocation and insert order must match emit order. A
  // batch being retried stays at the head of the chain — later batches wait behind it.
  let chain: Promise<void> = Promise.resolve()

  const attempt = async (batch: Pending[]) => {
    // A run's writer may be re-created (worker restart mid-run), or two writers of one run may
    // overlap (deploy): (re-)read the high-water mark whenever we are not sure of it.
    if (seq === null) seq = await store.maxSeq(runId)
    const base = seq
    const rows: NewRunEventRow[] = batch.map((p, i) => ({
      ns,
      runId,
      conversationId,
      seq: base + i + 1,
      type: p.frame.type,
      payload: p.frame,
      onlySink: p.only
    }))
    await store.append(rows, conversationId)
    seq = base + batch.length
  }

  const writeBatch = async (batch: Pending[]) => {
    let wait = baseMs
    for (let i = 1; ; i++) {
      try {
        await attempt(batch)
        return
      } catch (err) {
        // Includes a (run_id, seq) unique clash with another writer: re-read max(seq) and go on.
        seq = null
        if (i >= attempts) {
          const e = new RunEventWriteError(runId, batch.map(p => p.frame.type), err)
          console.error(`[bus] ${e.message}`)
          failure ??= e
          try { opts.onError?.(e) } catch { /* the reporter must not break the chain */ }
          return
        }
        await new Promise(r => setTimeout(r, wait))
        wait = Math.min(wait * 2, maxMs)
      }
    }
  }

  const kick = () => {
    if (timer) { clearTimeout(timer); timer = null }
    urgent = false
    const batch = pending
    pending = []
    if (batch.length) chain = chain.then(() => writeBatch(batch))
    return chain
  }
  const settled = async () => {
    await kick()
    if (failure) { const f = failure; failure = null; throw f }
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
    flush: settled,
    async close() {
      closed = true
      await settled()
    }
  }
}

/** Rows of the log in id order, this bus namespace only. Scope by conversation and/or run; resume
 *  after `afterId` or, within one run, after `afterSeq`.
 *
 *  ⚠ A bare conversation-scoped `afterId` cursor can SKIP rows: ids are assigned at insert but
 *  become visible at commit, so with two writers on one conversation (abort + new run, steer,
 *  workstream) a higher id may be visible before a lower one. Per run, `afterSeq` is safe (one
 *  writer orders its own seqs). Across runs, use `createRunEventReader`, which re-reads a window
 *  below its cursor and dedupes. */
export async function readRunEvents(q: { conversationId?: string; runId?: string; afterId?: number; afterSeq?: number; limit?: number }): Promise<RunEventRow[]> {
  if (!q.conversationId && !q.runId) throw new Error('readRunEvents needs conversationId or runId')
  if (q.afterSeq !== undefined && !q.runId) throw new Error('readRunEvents: afterSeq needs runId')
  const where = and(
    eq(runEvents.ns, busNs()),
    q.conversationId ? eq(runEvents.conversationId, q.conversationId) : undefined,
    q.runId ? eq(runEvents.runId, q.runId) : undefined,
    q.afterId !== undefined ? gt(runEvents.id, q.afterId) : undefined,
    q.afterSeq !== undefined ? gt(runEvents.seq, q.afterSeq) : undefined
  )
  return useDb().select().from(runEvents).where(where).orderBy(asc(runEvents.id)).limit(q.limit ?? 500)
}

export const DEFAULT_READER_LOOKBACK_IDS = 500

export interface RunEventReader {
  /** Rows not returned before, in id order. */
  next(limit?: number): Promise<RunEventRow[]>
  /** The highest id returned so far (or the starting `afterId`). */
  cursor(): number
}

/** A conversation-scoped reader that does not skip late-committing rows: every read re-scans the
 *  `lookbackIds` ids below its cursor and dedupes by (run_id, seq). Rows at or below the starting
 *  `afterId` are never returned (the caller already has them). */
export function createRunEventReader(q: { conversationId: string; afterId?: number; lookbackIds?: number }): RunEventReader {
  const floor = q.afterId ?? 0
  const lookback = Math.max(0, q.lookbackIds ?? DEFAULT_READER_LOOKBACK_IDS)
  let cur = floor
  const seen = new Map<string, number>() // `${runId}:${seq}` → id
  return {
    cursor: () => cur,
    async next(limit = 500) {
      const from = Math.max(floor, cur - lookback)
      const rows = await readRunEvents({ conversationId: q.conversationId, afterId: from, limit: limit + seen.size })
      const fresh: RunEventRow[] = []
      for (const r of rows) {
        const k = `${r.runId}:${r.seq}`
        if (seen.has(k)) continue
        seen.set(k, r.id)
        fresh.push(r)
        if (r.id > cur) cur = r.id
        if (fresh.length >= limit) break
      }
      for (const [k, id] of seen) if (id <= cur - lookback) seen.delete(k)
      return fresh
    }
  }
}

/** Parses a `run_event` NOTIFY payload (`'<conversation_id>:<id>'`). */
export function parseRunEventNotify(payload: string): { conversationId: string; id: number } | null {
  const i = payload.lastIndexOf(':')
  if (i <= 0) return null
  const id = Number(payload.slice(i + 1))
  return Number.isSafeInteger(id) ? { conversationId: payload.slice(0, i), id } : null
}
