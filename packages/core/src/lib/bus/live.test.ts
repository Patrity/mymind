// Cycle 81 Task 2 — the live bridge's reconnect resync against an injected fake listen client (no DB).
// Task 1 counted readies from 0 at bridge start, so when the listener was ALREADY connected (another
// subscriber got there first — the web's run_event reader, the worker's command handler) the first
// real reconnect was taken for "the initial connect" and its resync was lost.
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { closeListener, isListenReady, listenReady, onNotify, setListenClientFactory, type ListenClient } from './listen'
import { startLiveBridge } from './live'
import { setBusNs } from './ns'
import { subscribeChanges } from '../../utils/live-bus'

class FakeClient extends EventEmitter {
  async connect() {}
  async query() { return {} }
  async end() {}
}

function install() {
  const made: FakeClient[] = []
  setListenClientFactory(() => {
    const c = new FakeClient()
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

const offs: Array<() => void> = []
afterEach(async () => {
  for (const off of offs.splice(0)) off()
  await closeListener()
  setListenClientFactory(null)
  setBusNs(null)
})

function watchResyncs(): string[] {
  const seen: string[] = []
  offs.push(subscribeChanges(e => { if (e.resource === 'resync') seen.push(e.id) }))
  return seen
}

describe('live bridge resync', () => {
  it('bridge started before the first connect: the connect is not a gap, the reconnect resyncs once', async () => {
    setBusNs('live-unit-a')
    const made = install()
    const resyncs = watchResyncs()
    offs.push(startLiveBridge('web'))
    await listenReady()
    expect(resyncs).toEqual([])
    made[0]!.emit('end')
    await until(() => made.length === 2 && isListenReady())
    await until(() => resyncs.length === 1)
    expect(resyncs).toEqual(['bus-reconnect'])
  })

  it('bridge started on an ALREADY-connected listener: the first reconnect still resyncs', async () => {
    setBusNs('live-unit-b')
    const made = install()
    offs.push(onNotify('run_event', () => {})) // someone else connects the listener first
    await listenReady()
    expect(isListenReady()).toBe(true)
    const resyncs = watchResyncs()
    offs.push(startLiveBridge('web'))
    await listenReady()
    expect(resyncs).toEqual([])
    made[0]!.emit('end')
    await until(() => made.length === 2 && isListenReady())
    await until(() => resyncs.length === 1, 1_000)
    expect(resyncs).toEqual(['bus-reconnect'])
  })
})
