// Cycle 81 Task 1 — the Postgres bus against the real (shared) dev DB. Every row this file writes
// is scoped: run_events hang off a conversation it creates (cascade-deleted in afterAll);
// worker_commands carry this file's TAG in their payload and are deleted by it.
// Child processes (the "worker" side) run under plain tsx and are always killed in `finally`.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
import { createRunEventWriter, readRunEvents, type HubFrame } from './events'
import { closeListener, listenReady, onListenReady, onNotify, setListenClientFactory, type ListenClient } from './listen'
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

function spawnChild(args: string[]): { child: ChildProcess; out: () => string; ready: (marker: string) => Promise<void> } {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', TSX_ESM, CHILD, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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

afterAll(async () => {
  await closeListener()
  const db = useDb()
  await db.delete(workerCommands).where(sql`${workerCommands.payload}::text like ${`%${TAG}%`}`)
  await db.delete(workerHeartbeat).where(eq(workerHeartbeat.bootId, BOOT))
  if (convId) await db.delete(conversations).where(eq(conversations.id, convId)) // cascades run_events
})

describe('run_events', () => {
  it('append + NOTIFY reaches a LISTENer on a second pg client', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      const got: string[] = []
      other.on('notification', m => { if (m.channel === 'run_event' && m.payload?.startsWith(convId)) got.push(m.payload) })
      await other.query('LISTEN run_event')
      const runId = randomUUID()
      const w = createRunEventWriter(runId, convId)
      w.emit({ type: 'state', state: 'thinking' })
      await w.close()
      await until(() => got.length > 0)
      const rows = await readRunEvents({ runId })
      expect(rows).toHaveLength(1)
      expect(got[0]).toBe(`${convId}:${rows[0]!.id}`)
      expect(rows[0]).toMatchObject({ seq: 1, type: 'state', payload: { type: 'state', state: 'thinking' }, onlySink: null, conversationId: convId })
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
      await useDb().execute(sql`select pg_notify('live_change', ${`{"probe":"${TAG}"}`})`)
      await until(() => got.length === 1)
    } finally {
      off()
      offReady()
      setListenClientFactory(null)
    }
  })
})

describe('worker_commands', () => {
  it('sendCommand(awaitResult) round-trips with a handler in a child process; a throwing handler is a typed failure', async () => {
    await listenReady()
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
      const [row] = await useDb().insert(workerCommands).values({ type: 'undo', payload: { token: `${TAG}-poll` } }).returning()
      await until(() => seen.includes(`undo:${TAG}-poll`), 3_000)
      const [after] = await useDb().select().from(workerCommands).where(eq(workerCommands.id, row!.id))
      expect(after?.handledAt).not.toBeNull()
      expect(after?.result).toMatchObject({ ok: true, value: { ok: true } })
      expect(seen.filter(s => s === `undo:${TAG}-poll`)).toHaveLength(1)
    } finally { stop() }
  })

  it('heartbeat: beatWorker upserts; workerStatus reads the newest beat as online', async () => {
    await beatWorker(BOOT)
    await beatWorker(BOOT)
    const rows = await useDb().select().from(workerHeartbeat).where(inArray(workerHeartbeat.bootId, [BOOT]))
    expect(rows).toHaveLength(1)
    const s = await workerStatus()
    expect(s.online).toBe(true)
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
    'workstream-control': async () => undefined
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
      await useDb().execute(sql`select pg_notify('live_change', ${'{"barrier":true}'})`)
      await sleep(400)
      expect(seen.filter(s => s === remoteId)).toHaveLength(1)
      expect(seen.filter(s => s === localId)).toHaveLength(1)
    } finally {
      off()
      stop()
    }
  }, 60_000)
})
