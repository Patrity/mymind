// Cycle 81 (spec §3): the ONE dedicated LISTEN connection of this process. LISTEN is
// session-scoped, so it can never ride the drizzle pool (a pooled client would be handed to
// another query mid-session and a pooled LISTEN dies silently when the pool recycles it).
//
// - Lazy: the client connects on the first `onNotify`.
// - Multiplexed: one client, any number of channels and handlers.
// - Namespaced: every bus NOTIFY payload is `<ns>:<payload>` (ns.ts); a notify from another
//   namespace is dropped here, and handlers receive the bare payload.
// - Self-healing: on error/end, or a health ping that fails OR hangs (a half-open socket answers
//   nothing and pg's query would wait forever), the client is dropped and a new one is connected
//   with backoff; every channel that still has handlers is LISTENed again, then the
//   `onListenReady` hooks fire so consumers can re-read whatever they missed while disconnected
//   (NOTIFY is fire-and-forget — anything sent while we were down is gone).
// - Injectable: `setListenClientFactory` swaps the pg client (tests, application_name tagging).
import pg from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import { coreConfig } from '../../config'
import { useDb } from '../../db'
import { nsUnwrap, nsWrap, processBusNs } from './ns'
import { outsideEvalScope } from '../eval/context'

export type BusChannel = 'run_event' | 'worker_command' | 'live_change'
const CHANNELS: ReadonlySet<string> = new Set<BusChannel>(['run_event', 'worker_command', 'live_change'])

/** The slice of `pg.Client` the listener uses — what an injected client must provide. */
export interface ListenClient {
  connect(): Promise<unknown>
  query(text: string): Promise<unknown>
  end(): Promise<void>
  on(event: 'notification', fn: (msg: { channel: string, payload?: string }) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  on(event: 'end', fn: () => void): unknown
  removeAllListeners(event?: string): unknown
}
export type ListenClientFactory = () => ListenClient

export class ListenerClosedError extends Error {
  readonly code = 'LISTENER_CLOSED' as const
  constructor() { super('bus listener is closed'); this.name = 'ListenerClosedError' }
}

const KEEPALIVE_DELAY_MS = 10_000
const defaultFactory: ListenClientFactory = () => new pg.Client({
  connectionString: coreConfig().databaseUrl,
  keepAlive: true,
  keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
  application_name: `mymind-listen:${process.pid}`
}) as unknown as ListenClient

const DEFAULT_TIMINGS = { pingMs: 30_000, pingTimeoutMs: 10_000, backoffMinMs: 250, backoffMaxMs: 5_000 }
let timings = { ...DEFAULT_TIMINGS }

let factory: ListenClientFactory = defaultFactory
const handlers = new Map<BusChannel, Set<(payload: string) => void>>()
const readyHooks = new Set<() => void>()
let client: ListenClient | null = null
let listening = new Set<BusChannel>()
/** LISTENs issued on a live client for channels subscribed after it became ready. */
const lateListens = new Set<Promise<unknown>>()
let connecting: Promise<void> | null = null
interface Waiter { resolve: () => void; reject: (e: Error) => void }
let readyWaiters: Waiter[] = []
let ready = false
let closed = false
let backoff = DEFAULT_TIMINGS.backoffMinMs
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
/** Bumped whenever a client is torn down: a late callback of an old client must not act. */
let generation = 0

const quote = (ch: BusChannel) => `"${ch}"`

function dispatch(channel: string, wire: string) {
  if (!CHANNELS.has(channel)) return
  const m = nsUnwrap(wire)
  if (!m || m.ns !== processBusNs()) return
  for (const fn of [...(handlers.get(channel as BusChannel) ?? [])]) {
    try { fn(m.payload) } catch (err) { console.error(`[bus] ${channel} handler threw`, err) }
  }
}

function settleWaiters(err?: Error) {
  const ws = readyWaiters
  readyWaiters = []
  for (const w of ws) err ? w.reject(err) : w.resolve()
}

function dropClient(): ListenClient | null {
  generation++
  ready = false
  listening = new Set()
  lateListens.clear()
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  const c = client
  client = null
  if (c) {
    c.removeAllListeners()
    c.on('error', () => {}) // a dying socket may still emit; never let it crash the process
  }
  return c
}

function teardown() {
  const c = dropClient()
  if (c) void c.end().catch(() => {})
}

function scheduleReconnect() {
  if (closed || reconnectTimer) return
  const wait = backoff
  backoff = Math.min(backoff * 2, timings.backoffMaxMs)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void ensureConnected()
  }, wait)
  reconnectTimer.unref?.()
}

function lost(gen: number, why: unknown) {
  if (gen !== generation) return
  if (!closed) console.warn('[bus] listen connection lost; reconnecting', why instanceof Error ? why.message : why)
  teardown()
  // Nobody subscribed: don't loop in the background — fail whoever is waiting, deterministically.
  if (!handlers.size) { settleWaiters(why instanceof Error ? why : new Error(String(why))); return }
  scheduleReconnect()
}

/** One health probe: `select 1` must answer within pingTimeoutMs, else the socket is presumed
 *  half-open and the connection is replaced. */
function ping(c: ListenClient, gen: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`health ping timed out after ${timings.pingTimeoutMs}ms`)), timings.pingTimeoutMs)
    t.unref?.()
  })
  Promise.race([c.query('select 1'), timeout])
    .catch(err => lost(gen, err))
    .finally(() => clearTimeout(t))
}

async function connectOnce(): Promise<void> {
  const gen = ++generation
  const c = factory()
  client = c
  c.on('notification', (msg) => { if (gen === generation) dispatch(msg.channel, msg.payload ?? '') })
  c.on('error', (err) => lost(gen, err))
  c.on('end', () => lost(gen, 'connection ended'))
  try {
    await c.connect()
    // Re-check after each pass: a channel subscribed while we were awaiting must not be missed.
    for (;;) {
      const missing = [...handlers.keys()].filter(ch => !listening.has(ch))
      if (!missing.length) break
      for (const ch of missing) {
        await c.query(`LISTEN ${quote(ch)}`)
        listening.add(ch)
      }
    }
  } catch (err) {
    lost(gen, err)
    return
  }
  if (gen !== generation || closed) return
  backoff = timings.backoffMinMs
  ready = true
  pingTimer = setInterval(() => { if (gen === generation) ping(c, gen) }, timings.pingMs)
  pingTimer.unref?.()
  settleWaiters()
  for (const h of [...readyHooks]) {
    try { h() } catch (err) { console.error('[bus] listen-ready hook threw', err) }
  }
}

function ensureConnected(): Promise<void> {
  if (closed) return Promise.resolve()
  if (client && ready) return Promise.resolve()
  if (connecting) return connecting
  // Cycle 85: the LISTEN connection serves the whole process; one first started from inside an
  // eval call chain must not run its notification handlers (Tony's SSE readers) in that scope.
  connecting = outsideEvalScope(() => connectOnce()).finally(() => { connecting = null })
  return connecting
}

/** Subscribe to a bus channel (this namespace's notifies only; `payload` arrives without the ns
 *  prefix). The first subscriber of a channel LISTENs on it; the last one to leave UNLISTENs.
 *  Returns the unsubscribe function. */
export function onNotify(channel: BusChannel, fn: (payload: string) => void): () => void {
  if (!CHANNELS.has(channel)) throw new Error(`unknown bus channel: ${channel}`)
  closed = false
  let set = handlers.get(channel)
  if (!set) handlers.set(channel, set = new Set())
  set.add(fn)
  if (client && ready && !listening.has(channel)) {
    const c = client
    const gen = generation
    listening.add(channel)
    const q = c.query(`LISTEN ${quote(channel)}`).catch(err => lost(gen, err))
    lateListens.add(q)
    void q.finally(() => lateListens.delete(q))
  } else if (!client && !reconnectTimer) {
    void ensureConnected()
  }
  return () => {
    const cur = handlers.get(channel)
    if (!cur?.delete(fn) || cur.size) return
    handlers.delete(channel)
    if (client && ready && listening.delete(channel)) {
      const gen = generation
      client.query(`UNLISTEN ${quote(channel)}`).catch(err => lost(gen, err))
    }
  }
}

/** Called every time the listener (re)connects and has re-LISTENed: the place to re-read state
 *  that a NOTIFY sent during the outage would have pointed at. Returns the unsubscribe. */
export function onListenReady(fn: () => void): () => void {
  readyHooks.add(fn)
  return () => { readyHooks.delete(fn) }
}

/** Resolves once the listener is connected and LISTENing on every channel subscribed so far
 *  (including one subscribed a moment ago on an already-live connection). Rejects with
 *  ListenerClosedError after `closeListener()`, with the connect error when nothing is subscribed
 *  and the connect fails, or after `timeoutMs` while it keeps failing to (re)connect. */
export function listenReady(timeoutMs = 15_000): Promise<void> {
  if (closed) return Promise.reject(new ListenerClosedError())
  const waitLate = () => Promise.all([...lateListens]).then(() => {})
  if (ready && client) return waitLate()
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      readyWaiters = readyWaiters.filter(w => w !== waiter)
      reject(new Error(`bus listener not ready within ${timeoutMs}ms`))
    }, timeoutMs)
    t.unref?.()
    const waiter: Waiter = {
      resolve: () => { clearTimeout(t); waitLate().then(resolve, reject) },
      reject: (e) => { clearTimeout(t); reject(e) }
    }
    readyWaiters.push(waiter)
    if (!connecting && !reconnectTimer) void ensureConnected()
  })
}

export function isListenReady(): boolean { return ready && !!client }

/** `select pg_notify(<channel>, '<ns>:<payload>')` — usable inside a transaction (delivered on
 *  commit) or on its own. */
export function notifySql(channel: BusChannel, payload: string): SQL {
  return sql`select pg_notify(${channel}, ${nsWrap(payload)})`
}

/** NOTIFY on the pool (not the listen client), in this process's namespace. */
export async function busNotify(channel: BusChannel, payload: string): Promise<void> {
  await useDb().execute(notifySql(channel, payload))
}

/** Inject the pg client constructor (tests; a role-tagged application_name). Drops the current
 *  connection; the next subscription — or an existing one, immediately — reconnects with it. */
export function setListenClientFactory(f: ListenClientFactory | null): void {
  factory = f ?? defaultFactory
  if (client) {
    teardown()
    if (handlers.size && !closed) void ensureConnected()
  }
}

/** Tests: shorten the health-ping / backoff timings (null = defaults). */
export function configureListener(t: Partial<typeof DEFAULT_TIMINGS> | null): void {
  timings = { ...DEFAULT_TIMINGS, ...(t ?? {}) }
  backoff = timings.backoffMinMs
}

/** Shutdown/tests: drop every handler and hook, close the connection, and reject anyone still
 *  waiting in `listenReady()`. */
export async function closeListener(): Promise<void> {
  closed = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  handlers.clear()
  readyHooks.clear()
  const c = dropClient()
  settleWaiters(new ListenerClosedError())
  if (c) await c.end().catch(() => {})
  backoff = timings.backoffMinMs
}
