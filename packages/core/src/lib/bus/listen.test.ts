// Cycle 81 Task 1 — the LISTEN connection's lifecycle against an injected fake client (no DB).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { closeListener, listenReady, onListenReady, onNotify, setListenClientFactory, type ListenClient } from './listen'

class FakeClient extends EventEmitter {
  queries: string[] = []
  ended = false
  failConnect = false
  async connect() { if (this.failConnect) throw new Error('ECONNREFUSED') }
  async query(text: string) { this.queries.push(text); return {} }
  async end() { this.ended = true }
  notify(channel: string, payload: string) { this.emit('notification', { channel, payload }) }
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
})
