// Cycle 81 Task 1 — the Postgres bus against the real (shared) dev DB. Every test runs in its OWN
// bus namespace (setBusNs in beforeEach; children get it via MYMIND_BUS_NS), so nothing here can
// claim, answer, or be claimed by the dev web/worker — and its heartbeats never make the dev web
// report "worker online". run_events hang off a conversation this file creates (cascade-deleted);
// worker_commands / worker_heartbeat rows are deleted by namespace in afterAll.
// Process-wide state (listener, its factory/timings, the ns) is reset in afterEach, so no test
// depends on another's cleanup. Child processes (the "worker" side) run under plain tsx and are
// always killed in `finally`.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'
import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { conversations, runEvents, workerCommands } from '../../db/schema'
import { createRunEventReader, createRunEventWriter, readRunEvents, type HubFrame } from './events'
import { busNotify, closeListener, configureListener, listenReady, onListenReady, onNotify, setListenClientFactory, type ListenClient } from './listen'
import { busNs, BUS_NS_ENV, setBusNs } from './ns'
import { CommandFailedError, CommandTimeoutError, handleCommands, sendCommand, beatWorker, workerStatus } from './commands'
import { flushLive, startLiveBridge } from './live'
import { publishChange, subscribeChanges } from '../../utils/live-bus'
import { workerHeartbeat } from '../../db/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../../..')
const CHILD = join(HERE, '__fixtures__/bus-child.ts')
// tsx's ESM loader, imported INTO the child node process. Not the tsx CLI: that re-spawns a
// second node process, so the PID we hold (and kill) would not be the one running the handlers
// — a killed CLI leaves an orphan that keeps claiming commands.
const TSX_ESM = pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx/esm')).href
const TAG = `bus-test-${randomUUID()}`
const BOOT = `${TAG}-boot`
const NS_PREFIX = `bt${randomUUID().slice(0, 8)}`
let nsSeq = 0
const usedNs: string[] = []

let convId = ''
const delta = (turnId: number, id: string, d: string, kind: 'text' | 'reasoning' = 'text'): HubFrame =>
  ({ type: 'chunk', turnId, chunk: { type: `${kind}-delta`, id, delta: d } } as HubFrame)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function until<T>(fn: () => T | Promise<T>, ms = 5_000, step = 25): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('until: timed out')
    await sleep(step)
  }
}

function spawnChild(args: string[], ns = busNs()): { child: ChildProcess; out: () => string; ready: (marker: string) => Promise<void> } {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', TSX_ESM, CHILD, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [BUS_NS_ENV]: ns } })
  let out = ''
  child.stdout!.on('data', (d) => { out += String(d) })
  child.stderr!.on('data', (d) => { out += String(d) })
  return {
    child,
    out: () => out,
    ready: marker => until(() => {
      if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}: ${out}`)
      return out.includes(marker)
    }, 30_000, 50).then(() => {})
  }
}
function kill(child: ChildProcess) {
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
}

beforeAll(async () => {
  const [c] = await useDb().insert(conversations).values({ title: `BUS-TEST ${TAG}` }).returning()
  convId = c!.id
})

beforeEach(() => {
  const ns = `${NS_PREFIX}-${++nsSeq}`
  usedNs.push(ns)
  setBusNs(ns)
})

afterEach(async () => {
  await closeListener()
  setListenClientFactory(null)
  configureListener(null)
  setBusNs(null)
})

afterAll(async () => {
  await closeListener()
  const db = useDb()
  await db.delete(workerCommands).where(inArray(workerCommands.ns, usedNs))
  await db.delete(workerHeartbeat).where(inArray(workerHeartbeat.ns, usedNs))
  if (convId) await db.delete(conversations).where(eq(conversations.id, convId)) // cascades run_events
})

describe('run_events', () => {
  it('append + NOTIFY reaches a LISTENer on a second pg client', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      const got: string[] = []
      other.on('notification', m => { if (m.channel === 'run_event' && m.payload?.includes(convId)) got.push(m.payload) })
      await other.query('LISTEN run_event')
      const runId = randomUUID()
      const w = createRunEventWriter(runId, convId)
      w.emit({ type: 'state', state: 'thinking' })
      await w.close()
      await until(() => got.length > 0)
      const rows = await readRunEvents({ runId })
      expect(rows).toHaveLength(1)
      expect(got[0]).toBe(`${busNs()}:${convId}:${rows[0]!.id}`)
      expect(rows[0]).toMatchObject({ ns: busNs(), seq: 1, type: 'state', payload: { type: 'state', state: 'thinking' }, onlySink: null, conversationId: convId })
    } finally {
      await other.end()
    }
  })

  it('coalesces 20 deltas emitted within 50ms into ≤2 rows with identical concatenated text', async () => {
    const runId = randomUUID()
    const w = createRunEventWriter(runId, convId, { coalesceMs: 50 })
    const parts = Array.from({ length: 20 }, (_, i) => `t${i} `)
    for (const p of parts) { w.emit(delta(7, 'm-text-0', p)); await sleep(1) }
    await w.flush()
    const rows = await readRunEvents({ runId })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.length).toBeLessThanOrEqual(2)
    const text = rows.map(r => (r.payload as { chunk: { delta: string } }).chunk.delta).join('')
    expect(text).toBe(parts.join(''))
    expect(rows.map(r => r.seq)).toEqual(rows.map((_, i) => i + 1))
  })

  it('keeps order across delta/non-delta frames, never merges across parts or targeting', async () => {
    const runId = randomUUID()
    const w = createRunEventWriter(runId, convId, { coalesceMs: 50 })
    w.emit(delta(1, 'a', 'he'))
    w.emit(delta(1, 'a', 'llo'))
    w.emit({ type: 'state', state: 'tool' })
    w.emit(delta(1, 'a', ' again'))
    w.emit(delta(1, 'r', 'think', 'reasoning'))
    w.emit(delta(1, 'r', 'ing', 'reasoning'), 'sink-1')
    await w.close()
    w.emit({ type: 'state', state: 'idle' }) // ignored after close
    await sleep(80)
    const rows = await readRunEvents({ runId })
    expect(rows.map(r => [r.type, (r.payload as { chunk?: { delta: string } }).chunk?.delta ?? (r.payload as { state: string }).state, r.onlySink]))
      .toEqual([['chunk', 'hello', null], ['state', 'tool', null], ['chunk', ' again', null], ['chunk', 'think', null], ['chunk', 'ing', 'sink-1']])
  })

  it('readRunEvents replays after an id (conversation scope) and after a seq (run scope)', async () => {
    const runId = randomUUID()
    const w = createRunEventWriter(runId, convId)
    for (const m of ['one', 'two', 'three']) { w.emit({ type: 'error', message: m }); await w.flush() }
    const all = await readRunEvents({ runId })
    expect(all.map(r => r.seq)).toEqual([1, 2, 3])
    const afterFirst = await readRunEvents({ conversationId: convId, afterId: all[0]!.id })
    expect(afterFirst.map(r => (r.payload as { message: string }).message)).toEqual(['two', 'three'])
    const afterSeq2 = await readRunEvents({ runId, afterSeq: 2 })
    expect(afterSeq2.map(r => r.id)).toEqual([all[2]!.id])
    // A re-created writer for the same run continues the numbering.
    const w2 = createRunEventWriter(runId, convId)
    w2.emit({ type: 'persisted', conversationId: convId })
    await w2.close()
    expect((await readRunEvents({ runId, afterSeq: 3 })).map(r => r.seq)).toEqual([4])
    await expect(readRunEvents({})).rejects.toThrow(/conversationId or runId/)
    // Another namespace sees none of it.
    setBusNs(`${busNs()}-other`)
    expect(await readRunEvents({ runId })).toEqual([])
  })

  it('two writers of one run: a real (run_id, seq) unique clash re-reads max(seq) and continues', async () => {
    const runId = randomUUID()
    const a = createRunEventWriter(runId, convId, { retry: { attempts: 3, baseMs: 5 } })
    const b = createRunEventWriter(runId, convId, { retry: { attempts: 3, baseMs: 5 } })
    a.emit({ type: 'state', state: 'thinking' }); await a.flush() // a: seq 1
    b.emit({ type: 'state', state: 'tool' }); await b.flush()     // b: reads max → seq 2
    a.emit({ type: 'state', state: 'idle' }); await a.close()     // a: tries 2 → 23505 → re-read → 3
    await b.close()
    const rows = await readRunEvents({ runId })
    expect(rows.map(r => [r.seq, (r.payload as { state: string }).state])).toEqual([[1, 'thinking'], [2, 'tool'], [3, 'idle']])
  })

  it('createRunEventReader does not skip a lower id that commits AFTER a higher one', async () => {
    const reader = createRunEventReader({ conversationId: convId, afterId: (await readRunEvents({ conversationId: convId, limit: 10_000 })).at(-1)?.id ?? 0 })
    const raw = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await raw.connect()
    try {
      const slowRun = randomUUID()
      await raw.query('begin')
      await raw.query(`insert into run_events (ns, run_id, conversation_id, seq, type, payload) values ($1, $2, $3, 1, 'state', '{"type":"state","state":"thinking"}')`, [busNs(), slowRun, convId])
      const fastRun = randomUUID()
      const w = createRunEventWriter(fastRun, convId)
      w.emit({ type: 'persisted', conversationId: convId })
      await w.close()
      const first = await reader.next()
      expect(first.map(r => r.runId)).toEqual([fastRun])
      await raw.query('commit')
      const second = await reader.next()
      expect(second.map(r => r.runId)).toEqual([slowRun])
      expect(second[0]!.id).toBeLessThan(first[0]!.id)
      expect(await reader.next()).toEqual([]) // deduped
    } finally {
      await raw.query('rollback').catch(() => {})
      await raw.end()
    }
  })
})

describe('listen connection', () => {
  it('reconnects and re-LISTENs after its backend is terminated', async () => {
    const app = `bus-listen-${TAG.slice(-12)}` // application_name is truncated at 63 bytes
    setListenClientFactory(() => new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: app }) as unknown as ListenClient)
    let readies = 0
    const offReady = onListenReady(() => { readies++ })
    const got: string[] = []
    const off = onNotify('live_change', p => { if (p.includes(TAG)) got.push(p) })
    try {
      await listenReady()
      await until(() => readies >= 1)
      const killed = await useDb().execute(sql`select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = ${app}`)
      expect(killed.rows).toHaveLength(1)
      await until(() => readies >= 2, 10_000)
      await busNotify('live_change', `{"probe":"${TAG}"}`)
      await until(() => got.length === 1)
    } finally {
      off()
      offReady()
    }
  })
})

describe('worker_commands', () => {
  it('sendCommand(awaitResult) round-trips with a handler in a child process; a throwing handler is a typed failure', async () => {
    const c = spawnChild(['commands'])
    try {
      await c.ready('READY')
      const res = await sendCommand('undo', { token: `${TAG}-tok` }, { awaitResult: true, timeoutMs: 10_000 })
      expect(res?.ok).toBe(true)
      expect(res?.reason).toBe(`undone:${TAG}-tok:pid=${c.child.pid}`)
      const err = await sendCommand('abort', { conversationId: `boom-${TAG}` }, { awaitResult: true, timeoutMs: 10_000 }).catch(e => e)
      expect(err).toBeInstanceOf(CommandFailedError)
      expect((err as Error).message).toContain(`boom from child ${c.child.pid}`)
    } finally {
      kill(c.child)
    }
  }, 60_000)

  it('times out at timeoutMs with a typed error and closes the unclaimed row (no late execution)', async () => {
    const t0 = Date.now()
    const err = await sendCommand('undo', { token: `${TAG}-late` }, { awaitResult: true, timeoutMs: 600 }).catch(e => e)
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(CommandTimeoutError)
    expect((err as CommandTimeoutError).code).toBe('COMMAND_TIMEOUT')
    expect((err as CommandTimeoutError).claimed).toBe(false)
    expect(took).toBeGreaterThanOrEqual(600)
    expect(took).toBeLessThan(3_000)
    const [row] = await useDb().select().from(workerCommands).where(eq(workerCommands.id, (err as CommandTimeoutError).commandId))
    expect(row?.claimedAt).toBeNull()
    expect(row?.handledAt).not.toBeNull()
    expect(row?.result).toMatchObject({ ok: false, timedOut: true })
    // A worker starting now must not pick it up.
    const seen: string[] = []
    const stop = handleCommands(handlersRecording(seen), { pollMs: 100 })
    try {
      await sleep(400)
      expect(seen.filter(s => s.includes(`${TAG}-late`))).toEqual([])
    } finally { stop() }
  })

  it('a command inserted with no NOTIFY (missed / no listener) is handled by the poll', async () => {
    const seen: string[] = []
    const stop = handleCommands(handlersRecording(seen), { pollMs: 150 })
    try {
      await sleep(200) // past the start-up sweep: only the interval poll can find it now
      const [row] = await useDb().insert(workerCommands).values({ ns: busNs(), type: 'undo', payload: { token: `${TAG}-poll` } }).returning()
      await until(() => seen.includes(`undo:${TAG}-poll`), 3_000)
      const [after] = await useDb().select().from(workerCommands).where(eq(workerCommands.id, row!.id))
      expect(after?.handledAt).not.toBeNull()
      expect(after?.result).toMatchObject({ ok: true, value: { ok: true } })
      expect(seen.filter(s => s === `undo:${TAG}-poll`)).toHaveLength(1)
    } finally { stop() }
  })

  it('heartbeat: beatWorker upserts; workerStatus reads THIS namespace\'s boot row only', async () => {
    await beatWorker(BOOT)
    await beatWorker(BOOT)
    const rows = await useDb().select().from(workerHeartbeat).where(inArray(workerHeartbeat.bootId, [BOOT]))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ns).toBe(busNs())
    expect(await workerStatus()).toMatchObject({ online: true, bootId: BOOT, status: null })
    // Worker-owned status rides the beat (Task 2 fix M2); a later beat replaces it, a bare beat keeps it.
    await beatWorker(BOOT, { imessage: { ok: true, privateApi: true, checkedAt: 1 } })
    await beatWorker(BOOT, { imessage: { ok: false, privateApi: null, checkedAt: 2, error: 'down' } })
    await beatWorker(BOOT)
    expect((await workerStatus()).status).toEqual({ imessage: { ok: false, privateApi: null, checkedAt: 2, error: 'down' } })
    setBusNs(`${busNs()}-other`)
    expect(await workerStatus()).toEqual({ online: false, beatAt: null, bootId: null, status: null })
  })

  it('namespaces isolate commands: a worker in ns A never claims ns B (notify or poll); its own ns is answered', async () => {
    const nsA = busNs()
    const c = spawnChild(['commands'], nsA)
    try {
      await c.ready('READY')
      setBusNs(`${nsA}-b`)
      usedNs.push(busNs())
      const err = await sendCommand('undo', { token: `${TAG}-other-ns` }, { awaitResult: true, timeoutMs: 1_000 }).catch(e => e)
      expect(err).toBeInstanceOf(CommandTimeoutError) // the child polls every 200ms: it had 5 chances
      expect((err as CommandTimeoutError).claimed).toBe(false)
      // A notify in A's namespace that points at B's row (forged / mis-routed) must not claim it.
      const [rowB] = await useDb().insert(workerCommands).values({ ns: busNs(), type: 'undo', payload: { token: `${TAG}-forged` } }).returning()
      setBusNs(nsA)
      await busNotify('worker_command', String(rowB!.id))
      await sleep(600)
      const [afterB] = await useDb().select().from(workerCommands).where(eq(workerCommands.id, rowB!.id))
      expect(afterB?.claimedAt).toBeNull()
      const res = await sendCommand('undo', { token: `${TAG}-same-ns` }, { awaitResult: true, timeoutMs: 10_000 })
      expect(res?.reason).toBe(`undone:${TAG}-same-ns:pid=${c.child.pid}`)
    } finally {
      kill(c.child)
    }
  }, 60_000)

  it('commands of one thread run in send order (abort before a later kick); other threads do not wait', async () => {
    const log: string[] = []
    const stop = handleCommands({
      ...handlersRecording([]),
      abort: async (p: { conversationId?: string }) => { log.push(`abort:start:${p.conversationId}`); await sleep(300); log.push(`abort:end:${p.conversationId}`); return { settled: true } },
      kick: async (p: { conversationId?: string }) => { log.push(`kick:${p.conversationId}`) }
    }, { pollMs: 100 })
    try {
      await listenReady()
      await sendCommand('abort', { conversationId: 'A' })
      await sendCommand('kick', { conversationId: 'A' })
      await sendCommand('kick', { conversationId: 'B' })
      await until(() => log.includes('kick:A'), 5_000)
      expect(log.indexOf('kick:A')).toBeGreaterThan(log.indexOf('abort:end:A'))
      expect(log.indexOf('kick:B')).toBeLessThan(log.indexOf('abort:end:A'))
    } finally { stop() }
  })

  it('abort and approval-decision bypass a thread blocked by a slow handler; a later command still waits for them', async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const stop = handleCommands({
      ...handlersRecording([]),
      kick: async (p: { conversationId?: string }) => {
        log.push(`kick:start:${p.conversationId}`)
        if (!log.includes('slow-done')) { await gate; log.push('slow-done') }
        log.push(`kick:end:${p.conversationId}`)
      },
      abort: async (p: { conversationId?: string }) => { log.push(`abort:${p.conversationId}`); return { settled: true } },
      'approval-decision': async (p: { requestId: string }) => { log.push(`approval:${p.requestId}`) }
    }, { pollMs: 100 })
    try {
      await listenReady()
      await sendCommand('kick', { conversationId: 'A' }) // slow: holds thread A until released
      await until(() => log.includes('kick:start:A'), 5_000)
      const abort = sendCommand('abort', { conversationId: 'A' }, { awaitResult: true, timeoutMs: 3_000 })
      // Task 4 will key approvals by conversation too; it must not queue behind the thread either.
      const approval = sendCommand('approval-decision', { requestId: 'R1', approved: true, conversationId: 'A' } as unknown as { requestId: string; approved: boolean }, { awaitResult: true, timeoutMs: 3_000 })
      await sendCommand('kick', { conversationId: 'A' }) // ordinary: waits for everything before it
      expect(await abort).toEqual({ settled: true })
      await approval
      expect(log).toContain('abort:A')
      expect(log).toContain('approval:R1')
      expect(log).not.toContain('slow-done') // both answered while the slow kick still held A
      await sleep(300)
      expect(log.filter(l => l === 'kick:start:A')).toHaveLength(1) // the second kick is still queued
      release()
      await until(() => log.filter(l => l === 'kick:end:A').length === 2, 5_000)
      expect(log.lastIndexOf('kick:start:A')).toBeGreaterThan(log.indexOf('slow-done'))
    } finally { release(); stop() }
  })
})

function handlersRecording(seen: string[]) {
  return {
    kick: async () => { seen.push('kick') },
    abort: async () => ({ settled: true }),
    'approval-decision': async () => undefined,
    undo: async ({ token }: { token: string }) => { seen.push(`undo:${token}`); return { ok: true } },
    presence: async () => undefined,
    invalidate: async () => undefined,
    'workstream-control': async () => undefined,
    'workspace-reenable-network': async () => undefined,
    'workspace-read-text': async () => undefined,
    'workspace-view': async () => undefined,
    'workspace-kill-shell': async () => undefined,
    'imessage-health': async () => ({ ok: true, privateApi: null, checkedAt: null }),
    'eval-run': async () => ({ started: false })
  }
}

describe('live bridge', () => {
  it('delivers a worker-side publishChange to a web-side listener exactly once, and a local publish once (origin dedupe)', async () => {
    const stop = startLiveBridge('web')
    const seen: string[] = []
    const off = subscribeChanges(e => { if (e.id.startsWith(TAG)) seen.push(e.id) })
    try {
      await listenReady()
      const remoteId = `${TAG}-remote`
      const c = spawnChild(['live', remoteId])
      try {
        await c.ready('SENT')
        await until(() => seen.includes(remoteId), 5_000)
      } finally {
        kill(c.child)
      }
      const localId = `${TAG}-local`
      publishChange({ resource: 'task', action: 'updated', id: localId })
      await flushLive()
      // Our own NOTIFY comes back to us on the shared channel — give it time to arrive.
      await busNotify('live_change', '{"barrier":true}')
      await sleep(400)
      expect(seen.filter(s => s === remoteId)).toHaveLength(1)
      expect(seen.filter(s => s === localId)).toHaveLength(1)
    } finally {
      off()
      stop()
    }
  }, 60_000)

  it('after a listener reconnect the bridge emits ONE local resync change (missed notifies are unrecoverable)', async () => {
    const app = `bus-resync-${TAG.slice(-12)}`
    setListenClientFactory(() => new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: app }) as unknown as ListenClient)
    const stop = startLiveBridge('web')
    const resyncs: string[] = []
    const off = subscribeChanges(e => { if (e.resource === 'resync') resyncs.push(e.id) })
    try {
      await listenReady()
      await sleep(50)
      expect(resyncs).toEqual([]) // the first connect is not a gap
      await useDb().execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${app}`)
      await until(() => resyncs.length === 1, 10_000)
      await sleep(200)
      expect(resyncs).toEqual(['bus-reconnect'])
    } finally {
      off()
      stop()
    }
  }, 30_000)
})
