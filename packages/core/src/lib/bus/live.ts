// Cycle 81 (spec §3.3): `publishChange` / `publishActivity` across processes.
//
// The in-process emitters stay exactly as they are (local listeners — the web's SSE routes — keep
// working unchanged). The bridge adds two things:
//   out: every LOCAL publish is also sent as `NOTIFY live_change, <json>` tagged with this
//        process's origin id;
//   in:  every `live_change` notify from ANOTHER origin is re-emitted on the local emitter.
// A process LISTENs to its own NOTIFYs too; the origin id drops those echoes, so a web-side
// publish reaches its own SSE listeners exactly once. Re-delivered events are marked (by object
// identity) so the bridge never forwards them back out — no ping-pong between processes.
// Only this bus namespace's notifies are seen (listen.ts filters), so a test bridge and the dev
// web on one database never cross-deliver.
//
// Reconnect gap: a `live_change` sent while the listener was reconnecting is gone for good (the
// other channels recover from tables; this one has none). So on every listener ready AFTER the
// first, the bridge emits one local `{ resource: 'resync' }` change — the SSE client answers it
// by refetching everything it shows.
import { randomUUID } from 'node:crypto'
import type { LiveEvent } from '../../shared/types/live'
import type { ActivityEvent } from '../agent/types'
import { deliverChange, subscribeChanges } from '../../utils/live-bus'
import { publishActivity, subscribeActivity } from '../agent/bus'
import { busNotify, isListenReady, onListenReady, onNotify } from './listen'

/** Postgres rejects NOTIFY payloads ≥ 8000 bytes; stay clear of it. */
export const MAX_NOTIFY_BYTES = 7_900
const SUMMARY_CAP = 500

export type LiveWire =
  | { o: string; k: 'change'; e: LiveEvent }
  | { o: string; k: 'activity'; e: ActivityEvent }

let origin: string | null = null
/** This process's origin id (stable for the process lifetime). */
export function liveOrigin(): string {
  return origin ??= `${process.pid}:${randomUUID()}`
}

/** Encodes a wire message within the NOTIFY limit: an oversized activity event keeps its shape
 *  with a truncated `summary`; anything still too big is dropped (null). */
export function encodeLiveWire(w: LiveWire): string | null {
  let s = JSON.stringify(w)
  if (Buffer.byteLength(s) <= MAX_NOTIFY_BYTES) return s
  if (w.k === 'activity' && 'summary' in w.e && typeof w.e.summary === 'string') {
    s = JSON.stringify({ ...w, e: { ...w.e, summary: `${w.e.summary.slice(0, SUMMARY_CAP)}…` } })
    if (Buffer.byteLength(s) <= MAX_NOTIFY_BYTES) return s
  }
  return null
}

const inbound = new WeakSet<object>()
let active: { role: 'web' | 'worker'; stop: () => void; refs: number } | null = null
/** The role the bridge was started with (diagnostics), or null when it is not running. */
export function liveBridgeRole(): 'web' | 'worker' | null { return active?.role ?? null }

// Serialised: NOTIFYs leave in publish order (activity `thinking` → `idle` must not swap on
// two pool connections).
let sendChain: Promise<void> = Promise.resolve()
function send(w: LiveWire): void {
  sendChain = sendChain.then(() => sendNow(w))
}

/** Resolves once every event published so far has been NOTIFYed (shutdown, tests). */
export function flushLive(): Promise<void> { return sendChain }

async function sendNow(w: LiveWire) {
  const payload = encodeLiveWire(w)
  if (payload === null) {
    console.warn(`[bus] live ${w.k} event too large for NOTIFY; not forwarded`)
    return
  }
  try {
    await busNotify('live_change', payload)
  } catch (err) {
    console.error('[bus] live_change notify failed', err)
  }
}

/** Start forwarding live events between this process and the others. Idempotent per process
 *  (a second call shares the running bridge). Returns the stop function. */
export function startLiveBridge(role: 'web' | 'worker'): () => void {
  if (active) {
    active.refs++
    const a = active
    return () => { if (--a.refs <= 0 && active === a) { a.stop(); active = null } }
  }
  const me = liveOrigin()
  const offChange = subscribeChanges((e) => {
    if (!inbound.has(e)) send({ o: me, k: 'change', e })
  })
  const offActivity = subscribeActivity((e) => {
    if (!inbound.has(e)) send({ o: me, k: 'activity', e })
  })
  const offNotify = onNotify('live_change', (payload) => {
    let w: LiveWire
    try { w = JSON.parse(payload) as LiveWire } catch { return }
    if (!w || typeof w !== 'object' || w.o === me || !w.e || typeof w.e !== 'object') return
    inbound.add(w.e)
    if (w.k === 'change') deliverChange(w.e)
    else if (w.k === 'activity') publishActivity(w.e)
  })
  // Already connected when the bridge starts (another subscriber connected first): that connect
  // counts as the first ready, so the NEXT ready is a real reconnect and must resync.
  let readies = isListenReady() ? 1 : 0
  const offReady = onListenReady(() => {
    if (++readies === 1) return
    const e: LiveEvent = { v: 1, resource: 'resync', action: 'updated', id: 'bus-reconnect', at: Date.now() }
    inbound.add(e) // local only: every process resyncs on its own reconnect
    deliverChange(e)
  })
  const a = {
    role,
    refs: 1,
    stop: () => { offChange(); offActivity(); offNotify(); offReady() }
  }
  active = a
  return () => { if (--a.refs <= 0 && active === a) { a.stop(); active = null } }
}
