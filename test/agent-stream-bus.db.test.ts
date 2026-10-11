// Cycle 81 Task 3 — runs stream over the Postgres bus. A run executed by a WORKER CHILD PROCESS
// (test/fixtures/run-stream/run-child.ts, default publisher → run_events) must reach the web's relay
// as the same frame sequence a socket got from an in-process run of the same fake model (the golden,
// captured through a StreamHub); a subscriber joining mid-run replays from seq 1; a NEW relay (a
// restarted web process) re-attaching mid-run resumes without duplicates; only_sink is respected.
//
// Shared dev DB: everything runs in its own bus namespace (setBusNs + the child's MYMIND_BUS_NS), and
// every conversation/run/message row is created here and deleted in afterAll (run_events cascade
// with their conversation). Each run is INSERTED already 'running' and owned by this process (review
// M6): run claiming is not bus-namespace scoped, so a queued row could be claimed by a dev worker on the
// same database — a row that is never 'queued' cannot. The child only executes it.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentRuns, conversationMessages, conversations, runEvents } from '@mymind/core/db/schema'
import { BOOT_ID } from '@mymind/core/lib/agent/runtime/runs'
import { resolveSession } from '@mymind/core/lib/agent/runtime/sessions'
import { runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { StreamHub } from '@mymind/core/lib/agent/runtime/stream'
import { RunEventRelay, dbRelayDeps, type RelaySink } from '@mymind/core/lib/bus/relay'
import { closeListener, listenReady } from '@mymind/core/lib/bus/listen'
import { BUS_NS_ENV, setBusNs } from '@mymind/core/lib/bus/ns'
import { createRunEventWriter, type HubFrame } from '@mymind/core/lib/bus/events'
import { goldenAgent, noAssemble } from './fixtures/run-stream/golden-agent'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHILD = join(HERE, 'fixtures/run-stream/run-child.ts')
const TSX_ESM = pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx/esm')).href
const NS = `rs${randomUUID().slice(0, 8)}`
const convIds: string[] = []
const children: ChildProcess[] = []

beforeAll(() => { setBusNs(NS) })
afterAll(async () => {
  for (const c of children) if (c.exitCode === null && !c.killed) c.kill('SIGKILL')
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
  await closeListener()
  setBusNs(null)
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, ms = 20_000, step = 25): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('until: timed out')
    await sleep(step)
  }
}

// One title for every thread here: the `conversation` frame carries it, and the golden comparison
// must not differ by a label.
async function claimedRun(_label: string) {
  const s = await resolveSession('thread:new', { titleHint: 'RUNSTREAM-TEST' })
  convIds.push(s.conversationId)
  const [run] = await useDb().insert(agentRuns).values({
    conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive',
    input: { text: 'what is open?', modality: 'text' },
    status: 'running', owner: BOOT_ID, claimedAt: sql`now()`, aliveAt: sql`now()`
  }).returning()
  return { run: run!, conversationId: s.conversationId }
}

function collector(id: string): RelaySink & { frames: HubFrame[]; seqs: string[] } {
  const frames: HubFrame[] = []
  const seqs: string[] = []
  return { id, frames, seqs, deliver: (f, m) => { frames.push(f); seqs.push(`${m.runId}:${m.seq}`) } }
}

/** Coalescing merges adjacent deltas of one part into one frame; ids, turn ids and clocks differ
 *  run to run. Normalize both sides so only the frame SEQUENCE and content are compared. */
function normalize(frames: HubFrame[]): unknown[] {
  const merged: HubFrame[] = []
  for (const f of frames) {
    const last = merged[merged.length - 1]
    const c = f.type === 'chunk' ? f.chunk as { type: string; id?: string; delta?: string } : null
    const lc = last?.type === 'chunk' ? last.chunk as { type: string; id?: string; delta?: string } : null
    if (c && lc && (c.type === 'text-delta' || c.type === 'reasoning-delta') && c.type === lc.type && c.id === lc.id) {
      merged[merged.length - 1] = { ...last, chunk: { ...lc, delta: (lc.delta ?? '') + (c.delta ?? '') } } as HubFrame
    } else merged.push(f)
  }
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  const walk = (v: unknown, k = ''): unknown => {
    if (k === 'turnId') return 'TURN'
    if (k === 'createdAt' || k === 'startedAt') return 'DATE'
    if (k === 'ttftMs' || k === 'durationMs') return 'MS'
    if (typeof v === 'string') return v.replace(UUID, 'UUID')
    if (Array.isArray(v)) return v.map(x => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]))
    return v
  }
  return merged.map(f => walk(f))
}

function spawnWorker(runId: string, delayMs: number) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', TSX_ESM, CHILD, runId, String(delayMs)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [BUS_NS_ENV]: NS }
  })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => { out += String(d) })
  child.stderr!.on('data', (d) => { out += String(d) })
  return { child, out: () => out }
}

describe('run frames over the bus (worker child → web relay)', () => {
  it('streams the in-process golden sequence; late join and a restarted web resume from seq 1 without duplicates', async () => {
    // 1. Golden: the same fake model, in-process, captured the way a socket received it before.
    const golden = await claimedRun('golden')
    const hub = new StreamHub()
    const inproc: HubFrame[] = []
    hub.subscribe(golden.conversationId, { id: 'g', send: (d) => { if (typeof d === 'string') inproc.push(JSON.parse(d)) } })
    await runTurn(golden.run, { runAgent: goldenAgent() as never, assemble: noAssemble as never, hub, unavailableToolsets: async () => [] })
    expect(inproc.map(f => f.type)).toContain('persisted')

    // 2. The same turn executed by a worker child process; the web relay subscribed before it runs.
    const viaBus = await claimedRun('bus')
    const relay = new RunEventRelay(dbRelayDeps())
    const live = collector('sock-live')
    relay.subscribe(viaBus.conversationId, live, { replay: true })
    await listenReady()
    await relay.settled(viaBus.conversationId)
    const w = spawnWorker(viaBus.run.id, 120)

    // 3. Mid-run: a second socket attaches (late join), and a brand-new relay — a web process that
    //    restarted while the worker kept running — re-attaches a reconnecting socket.
    await until(() => live.frames.some(f => f.type === 'chunk' && (f.chunk as { type: string }).type === 'tool-input-available'))
    const late = collector('sock-late')
    relay.subscribe(viaBus.conversationId, late, { replay: true })
    const restarted = new RunEventRelay(dbRelayDeps())
    const back = collector('sock-back')
    restarted.subscribe(viaBus.conversationId, back, { replay: true })

    await until(() => w.out().includes('DONE'), 30_000)
    await until(() => [live, late, back].every(s => s.frames.some(f => f.type === 'persisted')))
    expect(w.out()).toMatch(/DONE (\d+) done/)
    expect(Number(/DONE (\d+)/.exec(w.out())![1])).not.toBe(process.pid) // executed in the child

    // Same sequence as the in-process golden (deltas coalesced on the bus, so compared merged).
    expect(normalize(live.frames)).toEqual(normalize(inproc))
    // (The model is paced at 120ms > the 50ms coalescing window here, so frames map 1:1; coalescing
    //  itself is covered by packages/core/src/lib/bus/bus.db.test.ts — normalize() makes this
    //  comparison hold either way.)
    // Late joiner and restarted web: every row exactly once, from seq 1, identical to live.
    for (const s of [late, back]) {
      expect(new Set(s.seqs).size).toBe(s.seqs.length)
      expect(s.seqs[0]).toBe(`${viaBus.run.id}:1`)
      expect(s.frames).toEqual(live.frames)
    }
    relay.close()
    restarted.close()
  }, 60_000)

  it('an only_sink row reaches only the socket it names', async () => {
    const { run, conversationId } = await claimedRun('only')
    const relay = new RunEventRelay(dbRelayDeps())
    const a = collector('sock-a')
    const b = collector('sock-b')
    relay.subscribe(conversationId, a)
    relay.subscribe(conversationId, b)
    await listenReady()
    await relay.settled(conversationId)
    const writer = createRunEventWriter(run.id, conversationId)
    writer.emit({ type: 'state', state: 'thinking' })
    writer.emit({ type: 'approval-resolved', requestId: 'r-1' }, 'sock-a')
    writer.emit({ type: 'state', state: 'idle' })
    await writer.close()
    await until(() => a.frames.length >= 3 && b.frames.length >= 2)
    await sleep(100)
    expect(a.frames.map(f => f.type)).toEqual(['state', 'approval-resolved', 'state'])
    expect(b.frames.map(f => f.type)).toEqual(['state', 'state'])
    const rows = await useDb().select().from(runEvents).where(inArray(runEvents.runId, [run.id]))
    expect(rows.find(r => r.type === 'approval-resolved')?.onlySink).toBe('sock-a')
    relay.close()
  }, 30_000)
})
