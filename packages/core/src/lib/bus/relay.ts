// Cycle 81 (spec §3.1): the web's side of the run-event log. Runs execute in apps/worker and
// append their hub frames to `run_events`; this relay fans them out to the voice sockets viewing
// each conversation — the job the in-process StreamHub did when runs lived in the web.
//
//   - ONE LISTEN connection (listen.ts) for the whole process; a `run_event` notify for a
//     conversation with subscribers pumps that conversation's reader.
//   - The reader is createRunEventReader (a lookback window + (run_id, seq) dedupe), so a row whose
//     id committed late is not skipped. It starts at the conversation's max id when the first
//     subscriber arrives: a subscriber gets live frames from then on, never history.
//   - Late join (`replay`): the conversation's RUNNING runs are re-read from seq 1 for that one
//     subscriber — a reload, a second tab, or a socket reconnecting to a NEW web process after a
//     deploy all see the turn so far, then live frames. Each subscriber remembers the highest seq it
//     was given per run, so the replay and the live reader overlapping never duplicates a frame.
//   - Missed notifies: every listener (re)connect re-pumps every conversation, and a poll re-pumps
//     the ones with recent activity every `pollMs` (default 2s).
//   - `only_sink` rows reach only the sink they name.
// Per conversation, every read and delivery runs on ONE serial chain, so a replay is never
// interleaved with live delivery to the same subscriber (a text-delta must never arrive before the
// start of its message).
import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentRuns } from '../../db/schema'
import { createRunEventReader, maxRunEventId, parseRunEventNotify, readRunEvents, type HubFrame, type RunEventReader, type RunEventRow } from './events'
import { onListenReady, onNotify } from './listen'

export interface RelaySink {
  /** The socket's id — what a row's `only_sink` names. */
  id: string
  deliver(frame: HubFrame, meta: { runId: string; seq: number }): void
}

type Row = Pick<RunEventRow, 'id' | 'runId' | 'seq' | 'payload' | 'onlySink'>

export interface RelayDeps {
  maxId(conversationId: string): Promise<number>
  reader(conversationId: string, afterId: number): Pick<RunEventReader, 'next'>
  /** Runs of the conversation executing right now — what a late joiner replays. */
  activeRuns(conversationId: string): Promise<string[]>
  readRun(runId: string, afterSeq: number, limit: number): Promise<Row[]>
  onNotify(fn: (payload: string) => void): () => void
  onListenReady(fn: () => void): () => void
  /** Missed-notify safety net, for conversations active within `activeWindowMs`. */
  pollMs?: number
  activeWindowMs?: number
}

export const RELAY_POLL_MS = 2_000
const ACTIVE_WINDOW_MS = 10 * 60_000
const PAGE = 500

export function dbRelayDeps(): RelayDeps {
  return {
    maxId: maxRunEventId,
    reader: (conversationId, afterId) => createRunEventReader({ conversationId, afterId }),
    async activeRuns(conversationId) {
      const rows = await useDb().select({ id: agentRuns.id }).from(agentRuns)
        .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.status, 'running')))
      return rows.map(r => r.id)
    },
    readRun: (runId, afterSeq, limit) => readRunEvents({ runId, afterSeq, limit }),
    onNotify: fn => onNotify('run_event', fn),
    onListenReady
  }
}

interface Sub {
  sink: RelaySink
  seen: Map<string, number>
  /** Live rows that arrived before this subscriber's replay ran — delivered right after it. */
  pending: Row[] | null
}
interface Conv {
  id: string
  subs: Map<string, Sub>
  reader: Pick<RunEventReader, 'next'> | null
  chain: Promise<void>
  pumpQueued: boolean
  activeUntil: number
}

export class RunEventRelay {
  private convs = new Map<string, Conv>()
  private stops: Array<() => void> = []
  private started = false
  private readonly pollMs: number
  private readonly activeWindowMs: number

  constructor(private deps: RelayDeps = dbRelayDeps()) {
    this.pollMs = deps.pollMs ?? RELAY_POLL_MS
    this.activeWindowMs = deps.activeWindowMs ?? ACTIVE_WINDOW_MS
  }

  /** Subscribe `sink` to a conversation's live frames; `replay` first re-sends its running runs
   *  from seq 1. Returns the unsubscribe. Synchronous: delivery starts once the reads land. */
  subscribe(conversationId: string, sink: RelaySink, opts: { replay?: boolean } = {}): () => void {
    this.start()
    let c = this.convs.get(conversationId)
    if (!c) {
      const conv: Conv = { id: conversationId, subs: new Map(), reader: null, chain: Promise.resolve(), pumpQueued: false, activeUntil: 0 }
      this.convs.set(conversationId, conv)
      // FIRST on the chain: the live cursor exists before any replay reads, so no row can fall
      // between "replayed" and "read live".
      this.enqueue(conv, async () => { conv.reader = this.deps.reader(conversationId, await this.deps.maxId(conversationId)) })
      c = conv
    }
    const conv = c
    const sub: Sub = { sink, seen: new Map(), pending: opts.replay ? [] : null }
    conv.subs.set(sink.id, sub)
    // A pump already queued (an earlier notify) may run before the replay: its rows wait in
    // `pending`, or they would mark seqs as seen and the replay would skip the turn's start.
    if (opts.replay) this.enqueue(conv, () => this.replay(conv, sub).finally(() => this.unpend(sub)))
    this.pump(conv)
    return () => {
      if (conv.subs.get(sink.id) === sub) conv.subs.delete(sink.id)
      if (!conv.subs.size && this.convs.get(conversationId) === conv) this.convs.delete(conversationId)
    }
  }

  /** Conversations with at least one subscriber (tests / diagnostics). */
  subscribedConversations(): string[] { return [...this.convs.keys()] }

  /** Resolves once everything queued so far for the conversation has run (tests). */
  async settled(conversationId: string): Promise<void> {
    await this.convs.get(conversationId)?.chain
  }

  close(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.started = false
    this.convs.clear()
  }

  private start() {
    if (this.started) return
    this.started = true
    this.stops.push(this.deps.onNotify((payload) => {
      const p = parseRunEventNotify(payload)
      const c = p && this.convs.get(p.conversationId)
      if (!c) return
      c.activeUntil = Date.now() + this.activeWindowMs
      this.pump(c)
    }))
    // A reconnect may have dropped notifies: catch every conversation up.
    this.stops.push(this.deps.onListenReady(() => { for (const c of this.convs.values()) this.pump(c) }))
    const t = setInterval(() => {
      const now = Date.now()
      for (const c of this.convs.values()) if (c.activeUntil > now) this.pump(c)
    }, this.pollMs)
    t.unref?.()
    this.stops.push(() => clearInterval(t))
  }

  private enqueue(c: Conv, fn: () => Promise<void>) {
    c.chain = c.chain.then(async () => {
      if (this.convs.get(c.id) !== c) return // everyone left; the conversation's state is gone
      try { await fn() } catch (err) { console.error(`[relay] conversation ${c.id}:`, err) }
    })
  }

  /** Read and deliver everything new. Coalesced: at most one pump waits on the chain. */
  private pump(c: Conv) {
    if (c.pumpQueued) return
    c.pumpQueued = true
    this.enqueue(c, async () => {
      c.pumpQueued = false
      if (!c.reader) return
      for (;;) {
        const rows = await c.reader.next(PAGE)
        if (rows.length) c.activeUntil = Date.now() + this.activeWindowMs
        for (const r of rows) this.deliver(c, r)
        if (rows.length < PAGE) return
      }
    })
  }

  private async replay(c: Conv, sub: Sub) {
    const runs = await this.deps.activeRuns(c.id)
    if (runs.length) c.activeUntil = Date.now() + this.activeWindowMs
    for (const runId of runs) {
      let after = 0
      for (;;) {
        const rows = await this.deps.readRun(runId, after, PAGE)
        for (const r of rows) { this.deliver(c, r, sub); after = Math.max(after, r.seq) }
        if (rows.length < PAGE) break
      }
    }
  }

  private unpend(sub: Sub) {
    const rows = sub.pending ?? []
    sub.pending = null
    for (const r of rows) this.deliverTo(sub, r)
  }

  private deliver(c: Conv, r: Row, only?: Sub) {
    if (only) {
      if (c.subs.get(only.sink.id) === only) this.deliverTo(only, r)
      return
    }
    for (const s of c.subs.values()) {
      if (s.pending) s.pending.push(r)
      else this.deliverTo(s, r)
    }
  }

  private deliverTo(s: Sub, r: Row) {
    if (r.onlySink && r.onlySink !== s.sink.id) return
    if (r.seq <= (s.seen.get(r.runId) ?? 0)) return
    s.seen.set(r.runId, r.seq)
    // A closed socket must never break delivery to the others.
    try { s.sink.deliver(r.payload as HubFrame, { runId: r.runId, seq: r.seq }) } catch { /* closed */ }
  }
}

let shared: RunEventRelay | null = null
/** The web process's relay (one LISTEN, every socket). */
export function runEventRelay(): RunEventRelay {
  return shared ??= new RunEventRelay()
}
