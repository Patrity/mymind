// Cycle 81 Task 1 — the LISTEN connection's lifecycle against an injected fake client (no DB).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { closeListener, configureListener, ListenerClosedError, listenReady, onListenReady, onNotify, setListenClientFactory, type ListenClient } from './listen'
import { nsWrap, setBusNs } from './ns'

class FakeClient extends EventEmitter {
  queries: string[] = []
  ended = false
  failConnect = false
  /** Half-open socket: every query after connect hangs forever. */
  hang = false
  /** Delay (ms) for LISTEN queries. */
  listenDelay = 0
  async connect() { if (this.failConnect) throw new Error('ECONNREFUSED') }
  async query(text: string) {
    this.queries.push(text)
    if (this.hang) return new Promise(() => {})
    if (this.listenDelay && text.startsWith('LISTEN')) await new Promise(r => setTimeout(r, this.listenDelay))
    return {}
  }
  async end() { this.ended = true }
  /** Delivers `payload` as this namespace's notify (or another one's with `ns`). */
  notify(channel: string, payload: string, ns?: string) { this.emit('notification', { channel, payload: nsWrap(payload, ns) }) }
}

function install(opts: { failFirst?: number } = {}) {
  const made: FakeClient[] = []
  let fails = opts.failFirst ?? 0
  setListenClientFactory(() => {
    const c = new FakeClient()
    if (fails > 0) { fails--; c.failConnect = true }
    made.push(c)
    return c as unknown as ListenClient
  })
  return made
}

async function until(fn: () => boolean, ms = 3_000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('until: timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

afterEach(async () => {
  await closeListener()
  setListenClientFactory(null)
  configureListener(null)
  setBusNs(null)
  vi.restoreAllMocks()
})

describe('listen connection', () => {
  it('connects lazily, multiplexes channels on ONE client and dispatches by channel', async () => {
    const made = install()
    expect(made).toHaveLength(0)
    const a: string[] = []
    const b: string[] = []
    onNotify('run_event', p => a.push(p))
    onNotify('worker_command', p => b.push(p))
    await listenReady()
    expect(made).toHaveLength(1)
    expect(made[0]!.queries).toEqual(['LISTEN "run_event"', 'LISTEN "worker_command"'])
    made[0]!.notify('run_event', 'c1:5')
    made[0]!.notify('worker_command', '9')
    made[0]!.notify('some_other_channel', 'x')
    expect(a).toEqual(['c1:5'])
    expect(b).toEqual(['9'])
  })

  it('UNLISTENs when the last handler of a channel leaves, LISTENs a late channel once', async () => {
    const made = install()
    const off1 = onNotify('live_change', () => {})
    const off2 = onNotify('live_change', () => {})
    await listenReady()
    onNotify('run_event', () => {})
    off1()
    expect(made[0]!.queries).toEqual(['LISTEN "live_change"', 'LISTEN "run_event"'])
    off2()
    expect(made[0]!.queries.at(-1)).toBe('UNLISTEN "live_change"')
  })

  it('on connection loss: reconnects with a NEW client, re-LISTENs every channel, fires ready hooks; the old client is inert', async () => {
    const made = install()
    let readies = 0
    onListenReady(() => { readies++ })
    const got: string[] = []
    onNotify('run_event', p => got.push(p))
    onNotify('live_change', p => got.push(p))
    await listenReady()
    expect(readies).toBe(1)
    made[0]!.emit('error', new Error('terminating connection due to administrator command'))
    await until(() => readies === 2)
    expect(made).toHaveLength(2)
    expect(made[0]!.ended).toBe(true)
    expect(made[1]!.queries).toEqual(['LISTEN "run_event"', 'LISTEN "live_change"'])
    made[0]!.notify('run_event', 'stale')
    made[1]!.notify('run_event', 'fresh')
    expect(got).toEqual(['fresh'])
  })

  it('keeps retrying (with backoff) while connecting fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const made = install({ failFirst: 2 })
    onNotify('worker_command', () => {})
    await until(() => made.length === 3, 5_000)
    await listenReady()
    expect(made[2]!.queries).toEqual(['LISTEN "worker_command"'])
  })

  it('a throwing handler does not stop the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const made = install()
    const got: string[] = []
    onNotify('run_event', () => { throw new Error('boom') })
    onNotify('run_event', p => got.push(p))
    await listenReady()
    made[0]!.notify('run_event', 'x')
    expect(got).toEqual(['x'])
  })

  it('drops a notify from another bus namespace and strips the prefix from its own', async () => {
    setBusNs('mine')
    const made = install()
    const got: string[] = []
    onNotify('worker_command', p => got.push(p))
    await listenReady()
    made[0]!.notify('worker_command', '41', 'theirs')
    made[0]!.emit('notification', { channel: 'worker_command', payload: 'no-prefix' })
    made[0]!.notify('worker_command', '42')
    expect(got).toEqual(['42'])
  })

  it('a health ping that HANGS (half-open socket) tears the client down and reconnects + re-LISTENs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureListener({ pingMs: 20, pingTimeoutMs: 40 })
    const made = install()
    let readies = 0
    onListenReady(() => { readies++ })
    onNotify('run_event', () => {})
    await listenReady()
    made[0]!.hang = true
    await until(() => readies === 2, 2_000)
    expect(made).toHaveLength(2)
    expect(made[0]!.ended).toBe(true)
    expect(made[1]!.queries[0]).toBe('LISTEN "run_event"')
  })

  it('listenReady() rejects after closeListener(), and rejects pending waiters on close', async () => {
    install()
    onNotify('run_event', () => {})
    const pending = listenReady()
    await closeListener()
    await expect(pending).rejects.toBeInstanceOf(ListenerClosedError)
    await expect(listenReady()).rejects.toBeInstanceOf(ListenerClosedError)
  })

  it('listenReady() with nothing subscribed rejects when the connect fails (no hang)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install({ failFirst: 2 })
    onNotify('run_event', () => {})() // re-opens after the previous test's close, then leaves
    await expect(listenReady()).rejects.toThrow(/ECONNREFUSED/)
  })

  it('listenReady() waits for the LISTEN of a channel subscribed after the client was ready', async () => {
    const made = install()
    onNotify('run_event', () => {})
    await listenReady()
    made[0]!.listenDelay = 60
    onNotify('live_change', () => {})
    const t0 = Date.now()
    await listenReady()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
  })
})
