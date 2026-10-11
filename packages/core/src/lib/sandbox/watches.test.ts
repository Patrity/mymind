// Cycle 82 Task 2: the watch runtime against a fake exec + in-memory store + manual timers (the real
// polling is in test/workspace-tools.db.test.ts, the workstream wake in test/workspace-watch.db.test.ts).
import { describe, expect, it, vi } from 'vitest'
import { createWatchRuntime, MAX_POLL_ERRORS, watchText, type WatchStore, type WorkspaceWatchRow } from './watches'
import { WATCH_POLL_SCRIPT } from './fs-ops'
import type { ExecOptions, SandboxExecResult } from './manager'
import type { WorkspaceRow } from './store'

vi.mock('../../db', () => ({ useDb: () => { throw new Error('no DB in unit tests') } }))

const WS = '88888888-8888-4888-8888-888888888888'
const res = (o: Partial<SandboxExecResult> = {}): SandboxExecResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, oom: false, aborted: false, truncated: false, tainted: false, ...o })
const poll = (exit: number | null, matched: boolean | null = null, tail = '') => res({ stdout: JSON.stringify({ exit, matched, tail }) })

function memWatches(): WatchStore & { rows: Map<string, WorkspaceWatchRow> } {
  const rows = new Map<string, WorkspaceWatchRow>()
  let n = 0
  return {
    rows,
    create: async (v) => {
      const r: WorkspaceWatchRow = { id: `w${++n}`, ...v, state: 'armed', polls: 0, lastExitCode: null, lastOutput: null, reason: null, resultText: null, deliveredAt: null, createdAt: new Date(), endedAt: null }
      rows.set(r.id, r)
      return r
    },
    get: async id => rows.get(id) ?? null,
    listArmed: async (f = {}) => [...rows.values()].filter(r => r.state === 'armed' && (!f.workspaceId || r.workspaceId === f.workspaceId)),
    recordPoll: async (id, p) => { const r = rows.get(id)!; r.polls++; r.lastExitCode = p.exitCode; r.lastOutput = p.output },
    end: async (id, state, reason, text) => { const r = rows.get(id); if (!r || r.state !== 'armed') return null; Object.assign(r, { state, reason, endedAt: new Date() }); r.resultText = text(r); return { ...r } },
    markDelivered: async (id) => { const r = rows.get(id); if (r && !r.deliveredAt) r.deliveredAt = new Date() },
    listUndelivered: async () => [...rows.values()].filter(r => r.state !== 'armed' && !r.deliveredAt && r.resultText)
  }
}

function setup(o: { now?: () => number; tainted?: boolean; deliverReply?: 'delivered' | 'pending' } = {}) {
  const store = memWatches()
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const execs: Array<{ command: string; o?: ExecOptions }> = []
  let reply: () => SandboxExecResult = () => poll(1)
  const delivered: WorkspaceWatchRow[] = []
  const rt = createWatchRuntime({
    exec: async (_id, command, eo) => { execs.push({ command, o: eo }); return reply() },
    workspace: async () => ({ id: WS, tainted: o.tainted ?? false } as WorkspaceRow),
    deliver: async (row) => { delivered.push(row); return o.deliverReply ?? 'delivered' },
    store,
    now: o.now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true }
  })
  const fire = async () => { const live = timers.filter(t => !t.cleared); for (const t of live) { t.cleared = true; t.fn() } await new Promise(r => setTimeout(r, 5)) }
  return { rt, store, timers, execs, delivered, fire, setReply: (f: typeof reply) => { reply = f } }
}
const base = { workspaceId: WS, workstreamId: null, conversationId: 'c1', command: 'make test', intervalSec: 30, timeoutMin: 10 }

describe('watch runtime', () => {
  it('until exit0: polls (command + pattern on stdin) until it exits 0, then delivers once', async () => {
    const { rt, store, execs, delivered, timers, fire, setReply } = setup()
    const w = await rt.create({ ...base, until: { kind: 'exit0' } })
    expect(timers[0]!.ms).toBe(0) // first poll at once
    await fire()
    expect(execs[0]!.command).toBe(WATCH_POLL_SCRIPT)
    expect(JSON.parse(execs[0]!.o!.input!)).toEqual({ command: 'make test', timeout: 30 })
    expect(timers.at(-1)!.ms).toBe(30_000)
    setReply(() => poll(0, null, 'ok: 12 passed'))
    await fire()
    expect(store.rows.get(w.id)).toMatchObject({ state: 'met', polls: 2 })
    expect(delivered.map(d => d.id)).toEqual([w.id])
    expect(delivered[0]!.resultText).toMatch(/^The watch you set is done: `make test` exits 0 \(after 2 polls\)\.\nLast output .*\n```\nok: 12 passed\n```$/s)
    expect(store.rows.get(w.id)!.deliveredAt).not.toBeNull()
    await fire()
    expect(delivered).toHaveLength(1)
  })
  it('until match: the regex verdict comes from the sandbox (pattern on stdin)', async () => {
    const { rt, store, execs, fire, setReply } = setup()
    const w = await rt.create({ ...base, until: { kind: 'match', pattern: 'READY' } })
    setReply(() => poll(0, false, 'starting'))
    await fire()
    expect(store.rows.get(w.id)!.state).toBe('armed') // exit 0 is not enough for a match watch
    expect(JSON.parse(execs[0]!.o!.input!).pattern).toBe('READY')
    setReply(() => poll(1, true, 'READY'))
    await fire()
    expect(store.rows.get(w.id)!.state).toBe('met')
  })
  it('times out at its deadline (the last wait is shortened to the deadline)', async () => {
    let now = 1_000_000
    const { rt, store, timers, delivered, fire } = setup({ now: () => now })
    const w = await rt.create({ ...base, until: { kind: 'exit0' }, intervalSec: 60, timeoutMin: 1.5 })
    await fire(); now += 60_000
    await fire()
    expect(timers.at(-1)!.ms).toBe(30_000)
    now += 30_000
    await fire()
    expect(store.rows.get(w.id)!.state).toBe('timeout')
    expect(delivered[0]!.resultText).toMatch(/timed out: `make test` never exited 0 \(2 polls; last exit 1\)/)
  })
  it(`${MAX_POLL_ERRORS} failed polls in a row end it as failed (and are delivered)`, async () => {
    const { rt, store, delivered, fire, setReply } = setup()
    setReply(() => res({ exitCode: 2, stderr: 'SandboxUnavailable' }))
    const w = await rt.create({ ...base, until: { kind: 'exit0' } })
    for (let i = 0; i < MAX_POLL_ERRORS; i++) await fire()
    expect(store.rows.get(w.id)).toMatchObject({ state: 'failed' })
    expect(delivered[0]!.resultText).toMatch(/failed: `make test` — 5 polls in a row failed/)
  })
  it('a tainted workspace\'s result never quotes the output', async () => {
    const { rt, delivered, fire, setReply } = setup({ tainted: true })
    setReply(() => poll(0, null, 'From: bank — your code is 991'))
    await rt.create({ ...base, until: { kind: 'exit0' } })
    await fire()
    expect(delivered[0]!.resultText).not.toContain('991')
    expect(delivered[0]!.resultText).toMatch(/not shown here because this workspace handled mail/)
  })
  it('re-arm after a restart: a new runtime on the same store polls armed watches and re-delivers undelivered results', async () => {
    const a = setup()
    const armed = await a.rt.create({ ...base, until: { kind: 'exit0' } })
    a.rt.stop()
    // An undelivered result (crash between ending and telling).
    const done = await a.store.create({ ...base, until: { kind: 'exit0' }, deadlineAt: new Date() })
    await a.store.end(done.id, 'met', null, () => 'done text')
    const b = createWatchRuntime({
      exec: async () => poll(0), workspace: async () => ({ id: WS, tainted: false } as WorkspaceRow),
      deliver: async (row) => { got.push(row.id); return 'delivered' }, store: a.store, log: { info: () => {}, warn: () => {}, error: () => {} },
      setTimer: (fn) => { queueMicrotask(fn); return {} }, clearTimer: () => {}
    })
    const got: string[] = []
    expect(await b.start()).toBe(1)
    await new Promise(r => setTimeout(r, 20))
    expect(got.sort()).toEqual([armed.id, done.id].sort())
    expect(a.store.rows.get(armed.id)!.state).toBe('met')
  })
  it('cancelFor (over quota) is idempotent; a "pending" chat delivery is retried', async () => {
    const { rt, store, delivered, timers } = setup({ deliverReply: 'pending' })
    const w = await rt.create({ ...base, until: { kind: 'exit0' } })
    expect(await rt.cancelFor(WS, 'over quota')).toBe(1)
    expect(await rt.cancelFor(WS, 'over quota')).toBe(0)
    expect(store.rows.get(w.id)).toMatchObject({ state: 'cancelled', reason: 'over quota', deliveredAt: null })
    expect(delivered).toHaveLength(1)
    expect(timers.filter(t => !t.cleared && t.ms === 10_000)).toHaveLength(1) // the note is retried
  })
  it('watchText pins the wording', () => {
    const row = { command: 'x', until: { kind: 'match', pattern: 'ok' }, polls: 1, lastExitCode: 0, lastOutput: null } as unknown as WorkspaceWatchRow
    expect(watchText(row, 'met', { workspaceTainted: false })).toBe('The watch you set is done: `x` output matches /ok/ (after 1 poll).')
  })
})
