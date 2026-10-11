// Cycle 81 Task 3 — the web's run-event relay against an in-memory log (no DB): only_sink targeting,
// late-join replay from seq 1 without duplicates, missed-notify recovery, ordering.
import { describe, it, expect } from 'vitest'
import { RunEventRelay, type RelayDeps, type RelaySink } from './relay'
import type { HubFrame } from './events'

interface Row { id: number; runId: string; conversationId: string; seq: number; payload: unknown; onlySink: string | null }
type Deps = RelayDeps

function fakeLog() {
  const rows: Row[] = []
  const running = new Set<string>()
  let notify: ((p: string) => void) | null = null
  let ready: (() => void) | null = null
  const seqs = new Map<string, number>()
  const append = (conversationId: string, runId: string, frame: HubFrame, onlySink: string | null = null, o: { silent?: boolean } = {}) => {
    const seq = (seqs.get(runId) ?? 0) + 1
    seqs.set(runId, seq)
    const id = rows.length + 1
    rows.push({ id, runId, conversationId, seq, payload: frame, onlySink })
    if (!o.silent) notify?.(`${conversationId}:${id}`)
  }
  const deps: RelayDeps = {
    maxId: async cid => Math.max(0, ...rows.filter(r => r.conversationId === cid).map(r => r.id)),
    reader: (cid, afterId) => {
      let cur = afterId
      return {
        async next(limit = 500) {
          const out = rows.filter(r => r.conversationId === cid && r.id > cur).slice(0, limit)
          if (out.length) cur = out[out.length - 1]!.id
          return out as never
        }
      }
    },
    activeRuns: async cid => [...running].filter(r => rows.some(x => x.runId === r && x.conversationId === cid)),
    readRun: async (runId, afterSeq, limit) => rows.filter(r => r.runId === runId && r.seq > afterSeq).slice(0, limit) as never,
    onNotify: (fn) => { notify = fn; return () => { notify = null } },
    onListenReady: (fn) => { ready = fn; return () => { ready = null } },
    pollMs: 60_000
  }
  return { rows, running, append, deps, reconnect: () => ready?.() }
}

function sink(id: string): RelaySink & { got: Array<{ frame: HubFrame; runId: string; seq: number }>; texts: () => string[] } {
  const got: Array<{ frame: HubFrame; runId: string; seq: number }> = []
  return {
    id, got,
    deliver: (frame, meta) => { got.push({ frame, ...meta }) },
    texts: () => got.map(g => (g.frame as { chunk?: { delta?: string } }).chunk?.delta ?? g.frame.type)
  }
}
const d = (t: string): HubFrame => ({ type: 'chunk', turnId: 1, chunk: { type: 'text-delta', id: 'x', delta: t } } as HubFrame)
const flush = async (relay: RunEventRelay, cid: string) => { for (let i = 0; i < 4; i++) await relay.settled(cid) }

describe('RunEventRelay', () => {
  it('only_sink rows reach only the sink they name; the rest fan out to every subscriber', async () => {
    const log = fakeLog()
    const relay = new RunEventRelay(log.deps)
    const a = sink('a'); const b = sink('b')
    relay.subscribe('c1', a); relay.subscribe('c1', b)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('all'))
    log.append('c1', 'r1', d('for-a'), 'a')
    log.append('c1', 'r1', d('all-again'))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['all', 'for-a', 'all-again'])
    expect(b.texts()).toEqual(['all', 'all-again'])
    relay.close()
  })

  it('a subscriber without replay gets live frames from when it subscribed, never history', async () => {
    const log = fakeLog()
    log.append('c1', 'r0', d('old'))
    const relay = new RunEventRelay(log.deps)
    const a = sink('a')
    relay.subscribe('c1', a)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('new'))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['new'])
    relay.close()
  })

  it('late join replays the RUNNING run from seq 1, then continues live — no frame twice', async () => {
    const log = fakeLog()
    log.running.add('r1')
    log.append('c1', 'r0', d('finished-run'))
    for (const t of ['one', 'two', 'three']) log.append('c1', 'r1', d(t))
    const relay = new RunEventRelay(log.deps)
    const early = sink('early')
    relay.subscribe('c1', early)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('four'))
    const late = sink('late')
    relay.subscribe('c1', late, { replay: true })
    log.append('c1', 'r1', d('five'))
    await flush(relay, 'c1')
    expect(late.texts()).toEqual(['one', 'two', 'three', 'four', 'five'])
    expect(late.got.map(g => g.seq)).toEqual([1, 2, 3, 4, 5])
    expect(early.texts()).toEqual(['four', 'five'])
    relay.close()
  })

  it('a NEW relay (a restarted web process) resumes a running run for a re-attaching socket without duplicates', async () => {
    const log = fakeLog()
    log.running.add('r1')
    const first = new RunEventRelay(log.deps)
    const s1 = sink('sock-1')
    first.subscribe('c1', s1, { replay: true })
    for (const t of ['a', 'b']) log.append('c1', 'r1', d(t))
    await flush(first, 'c1')
    first.close() // the web process went away mid-run; the worker keeps writing
    for (const t of ['c', 'd']) log.append('c1', 'r1', d(t), null, { silent: true })
    const second = new RunEventRelay(log.deps)
    const s2 = sink('sock-2')
    second.subscribe('c1', s2, { replay: true })
    log.append('c1', 'r1', d('e'))
    await flush(second, 'c1')
    expect(s2.texts()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(new Set(s2.got.map(g => g.seq)).size).toBe(s2.got.length)
    second.close()
  })

  it('rows whose notify was lost are read on the listener\'s reconnect', async () => {
    const log = fakeLog()
    const relay = new RunEventRelay(log.deps)
    const a = sink('a')
    relay.subscribe('c1', a)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('lost'), null, { silent: true })
    await flush(relay, 'c1')
    expect(a.texts()).toEqual([])
    log.reconnect()
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['lost'])
    relay.close()
  })

  it('rows whose notify was lost are read by the poll while the conversation is active', async () => {
    const log = fakeLog()
    const relay = new RunEventRelay({ ...log.deps, pollMs: 20 })
    const a = sink('a')
    relay.subscribe('c1', a)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('seen')) // activity → polled from now on
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('lost'), null, { silent: true })
    await new Promise(r => setTimeout(r, 80))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['seen', 'lost'])
    relay.close()
  })

  it('unsubscribe stops delivery; a closed sink never breaks the others', async () => {
    const log = fakeLog()
    const relay = new RunEventRelay(log.deps)
    const a = sink('a')
    const bad: RelaySink = { id: 'bad', deliver: () => { throw new Error('closed') } }
    const unsub = relay.subscribe('c1', a)
    relay.subscribe('c1', bad)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('x'))
    await flush(relay, 'c1')
    unsub()
    log.append('c1', 'r1', d('y'))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['x'])
    relay.close()
  })
  it('a reconnecting client resumes each named run just past its last seq — even a run that finished meanwhile', async () => {
    const log = fakeLog()
    log.running.add('r2')
    for (const t of ['a', 'b', 'c', 'finish']) log.append('c1', 'r1', d(t)) // r1 finished during the outage
    for (const t of ['x', 'y', 'z']) log.append('c1', 'r2', d(t))
    log.append('c2', 'r9', d('other-thread'))
    const relay = new RunEventRelay(log.deps)
    const s = sink('reconnected')
    relay.subscribe('c1', s, { after: { r1: 2, r2: 1, r9: 0 } })
    await flush(relay, 'c1')
    expect(s.texts()).toEqual(['c', 'finish', 'y', 'z']) // never another thread's run (r9)
    relay.close()
  })

  it('a failed cursor read at subscribe is retried by the next pump (review M2)', async () => {
    const log = fakeLog()
    let fail = true
    const deps: Deps = { ...log.deps, maxId: async (cid) => { if (fail) { fail = false; throw new Error('db blip') } return log.deps.maxId(cid) } }
    const err = console.error
    console.error = () => {}
    const relay = new RunEventRelay(deps)
    const a = sink('a')
    relay.subscribe('c1', a)
    await flush(relay, 'c1')
    console.error = err
    log.append('c1', 'r1', d('after-the-blip'))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['after-the-blip'])
    relay.close()
  })

  it('a just-subscribed thread is polled, so its FIRST lost notify is still read (review M3)', async () => {
    const log = fakeLog()
    const relay = new RunEventRelay({ ...log.deps, pollMs: 20 })
    const a = sink('a')
    relay.subscribe('c1', a)
    await flush(relay, 'c1')
    log.append('c1', 'r1', d('first-and-lost'), null, { silent: true })
    await new Promise(r => setTimeout(r, 80))
    await flush(relay, 'c1')
    expect(a.texts()).toEqual(['first-and-lost'])
    relay.close()
  })
})
