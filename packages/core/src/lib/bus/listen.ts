// Cycle 81 (spec §3): the ONE dedicated LISTEN connection of this process. LISTEN is
// session-scoped, so it can never ride the drizzle pool (a pooled client would be handed to
// another query mid-session and a pooled LISTEN dies silently when the pool recycles it).
//
// - Lazy: the client connects on the first `onNotify`.
// - Multiplexed: one client, any number of channels and handlers.
// - Self-healing: on error/end, or a failed health ping, the client is dropped and a new one is
//   connected with backoff; every channel that still has handlers is LISTENed again, then the
//   `onListenReady` hooks fire so consumers can re-read whatever they missed while disconnected
//   (NOTIFY is fire-and-forget — anything sent while we were down is gone).
// - Injectable: `setListenClientFactory` swaps the pg client (tests, application_name tagging).
import pg from 'pg'
import { coreConfig } from '../../config'

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

const defaultFactory: ListenClientFactory = () => new pg.Client({
  connectionString: coreConfig().databaseUrl,
  keepAlive: true,
  application_name: `mymind-listen:${process.pid}`
}) as unknown as ListenClient

const HEALTH_PING_MS = 30_000
const BACKOFF_MIN_MS = 250
const BACKOFF_MAX_MS = 5_000

let factory: ListenClientFactory = defaultFactory
const handlers = new Map<BusChannel, Set<(payload: string) => void>>()
const readyHooks = new Set<() => void>()
let client: ListenClient | null = null
let listening = new Set<BusChannel>()
let connecting: Promise<void> | null = null
let readyWaiters: Array<() => void> = []
let ready = false
let closed = false
let backoff = BACKOFF_MIN_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
/** Bumped whenever a client is torn down: a late callback of an old client must not act. */
let generation = 0

const quote = (ch: BusChannel) => `"${ch}"`

function dispatch(channel: string, payload: string) {
  if (!CHANNELS.has(channel)) return
  for (const fn of [...(handlers.get(channel as BusChannel) ?? [])]) {
    try { fn(payload) } catch (err) { console.error(`[bus] ${channel} handler threw`, err) }
  }
}

function teardown() {
  generation++
  ready = false
  listening = new Set()
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  const c = client
  client = null
  if (c) {
    c.removeAllListeners()
    c.on('error', () => {}) // a dying socket may still emit; never let it crash the process
    void c.end().catch(() => {})
  }
}

function scheduleReconnect() {
  if (closed || reconnectTimer || !handlers.size) return
  const wait = backoff
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
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
  scheduleReconnect()
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
  backoff = BACKOFF_MIN_MS
  ready = true
  pingTimer = setInterval(() => {
    if (gen !== generation) return
    c.query('select 1').catch(err => lost(gen, err))
  }, HEALTH_PING_MS)
  pingTimer.unref?.()
  const waiters = readyWaiters
  readyWaiters = []
  for (const w of waiters) w()
  for (const h of [...readyHooks]) {
    try { h() } catch (err) { console.error('[bus] listen-ready hook threw', err) }
  }
}

function ensureConnected(): Promise<void> {
  if (closed) return Promise.resolve()
  if (client && ready) return Promise.resolve()
  if (connecting) return connecting
  connecting = connectOnce().finally(() => { connecting = null })
  return connecting
}

/** Subscribe to a bus channel. The first subscriber of a channel LISTENs on it; the last one to
 *  leave UNLISTENs. Returns the unsubscribe function. */
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
    c.query(`LISTEN ${quote(channel)}`).catch(err => lost(gen, err))
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

/** Resolves once the listener is connected and LISTENing on every subscribed channel. */
export function listenReady(): Promise<void> {
  if (ready && client) return Promise.resolve()
  return new Promise((resolve) => {
    readyWaiters.push(resolve)
    if (!connecting && !reconnectTimer) void ensureConnected()
  })
}

export function isListenReady(): boolean { return ready && !!client }

/** Inject the pg client constructor (tests; a role-tagged application_name). Drops the current
 *  connection; the next subscription — or an existing one, immediately — reconnects with it. */
export function setListenClientFactory(f: ListenClientFactory | null): void {
  factory = f ?? defaultFactory
  if (client) {
    teardown()
    if (handlers.size && !closed) void ensureConnected()
  }
}

/** Shutdown/tests: drop every handler and hook and close the connection. */
export async function closeListener(): Promise<void> {
  closed = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  handlers.clear()
  readyHooks.clear()
  const c = client
  generation++
  ready = false
  listening = new Set()
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  client = null
  if (c) {
    c.removeAllListeners()
    c.on('error', () => {})
    await c.end().catch(() => {})
  }
  backoff = BACKOFF_MIN_MS
}
