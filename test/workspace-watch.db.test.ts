// Cycle 82 Task 2 — `watch` × workstreams through the REAL queue → runner → loop path (dev DB), with
// a fake sandbox manager (the poll's verdict is scripted; the real-container polling is proven in
// test/workspace-tools.db.test.ts). Proves: a segment that ends with a watch armed WAITS (paused, no
// budget) and the watch's result resumes it as an event (segment:watch, never as Tony's words); a
// watch that fires while a segment runs is picked up at that segment's end; a chat watch posts a note.
process.loadEnvFile('.env')
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { and, asc, eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, conversationMessages, conversations, runEvents, workerCommands, workspaceWatches, workspaces, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { pumpOnce, setExecutionMode, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import { createConversation } from '@mymind/core/services/conversations'
import { pauseWorkstreamForTony, startWorkstream, WAITING_FOR_WATCH, wakeWorkstreamForWatch, watchDeliveryDeps } from '@mymind/core/lib/agent/workstreams/loop'
import { getWorkstream } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import { createWorkspaceRuntime, finishedWorkstreamsWithLiveWorkspaces, resolveWorkspace, runtimeHooks, setWorkspaceRuntime, startWorkspaceRuntime, TAINTED_REASON, teardownWorkstreamWorkspace, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { dbShellStore } from '@mymind/core/lib/sandbox/shells'
import { dbWatchStore, WATCH_CAPS } from '@mymind/core/lib/sandbox/watches'
import { dbWorkspaceStore, ensureWorkstreamWorkspace } from '@mymind/core/lib/sandbox/store'
import { patchWorkstream } from '@mymind/core/lib/agent/workstreams/store'
import { WATCH_POLL_SCRIPT } from '@mymind/core/lib/sandbox/fs-ops'
import type { SandboxManager, SandboxExecResult } from '@mymind/core/lib/sandbox/manager'
import type { RunAgentCtx, AgentMessage, AgentEvent } from '@mymind/core/lib/agent/run'
import { stubOutcomeVerifier } from './helpers/outcome-stub'
stubOutcomeVerifier() // cycle 85: finishes here are not about the outcome judge

const NS = `t2-watch-${process.pid}`
const convIds: string[] = []
const wsIds: string[] = []
const realNotify = { ...workstreamNotifyDeps }
let met = false
const res = (stdout: string, exitCode = 0): SandboxExecResult => ({ exitCode, stdout, stderr: '', timedOut: false, oom: false, aborted: false, truncated: false, tainted: false })
const fakeManager = {
  exec: async (_id: string, cmd: string) => cmd === WATCH_POLL_SCRIPT ? res(JSON.stringify({ exit: met ? 0 : 1, matched: null, tail: met ? 'BUILD OK' : 'building…' })) : res(''),
  checkQuota: async () => {}
} as unknown as SandboxManager
let rt: WorkspaceRuntime

beforeAll(() => {
  setBusNs(NS); setExecutionMode('remote')
  workstreamNotifyDeps.isAway = async () => false
  workstreamNotifyDeps.text = async () => []
  rt = createWorkspaceRuntime(fakeManager)
  setWorkspaceRuntime(rt)
})
afterAll(async () => {
  rt.watches.stop()
  setWorkspaceRuntime(null)
  Object.assign(workstreamNotifyDeps, realNotify)
  const db = useDb()
  const wss = convIds.length ? await db.select({ id: workstreams.id }).from(workstreams).where(inArray(workstreams.conversationId, convIds)) : []
  if (wss.length) await db.delete(workspaces).where(inArray(workspaces.workstreamId, wss.map(w => w.id)))
  if (wsIds.length) await db.delete(workspaces).where(inArray(workspaces.id, wsIds))
  if (convIds.length) {
    await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
    await db.delete(workstreams).where(inArray(workstreams.conversationId, convIds))
    await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
    await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
    await db.delete(conversations).where(inArray(conversations.id, convIds))
  }
  await db.delete(workspaces).where(eq(workspaces.ns, NS)) // catch-all (final fix wave): no orphans
  await db.delete(runEvents).where(eq(runEvents.ns, NS))
  await db.delete(workerCommands).where(eq(workerCommands.ns, NS))
  setExecutionMode('local')
  setBusNs(null)
  await closeListener()
})

type Script = (ctx: RunAgentCtx, messages: AgentMessage[], seg: number) => AsyncGenerator<AgentEvent>
const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
function step(ctx: RunAgentCtx): void { ctx.onStep?.({ inputTokens: 10, outputTokens: 5 }) }
/** A tool call the way buildAiTools makes it (runId + the run's taint bit). */
async function callTool(ctx: RunAgentCtx, name: string, args: Record<string, unknown>) {
  const t = ctx.profile?.tools.find(x => x.name === name)
  if (!t) throw new Error(`tool ${name} is not in this run's registry`)
  return (await t.handler(args, { signal: ctx.signal, runId: ctx.runId, isTainted: () => false })).result as Record<string, any>
}
function harness(script: Script) {
  const seen: Array<{ last: string; lastRole: string; toolsets: string[] }> = []
  const runAgent = (messages: AgentMessage[], ctx: RunAgentCtx) => {
    const n = seen.length
    seen.push({ last: String(messages[messages.length - 1]?.content ?? ''), lastRole: messages[messages.length - 1]?.role ?? '', toolsets: ctx.toolsets?.initial ?? [] })
    return script(ctx, messages, n)
  }
  const runFn = (r: AgentRun) => runTurn(r, { runAgent: runAgent as never, assemble: noAssemble as never, unavailableToolsets: async () => [] })
  const drive = async (convId: string, rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      const started = await pumpOnce({ onlyConversations: [convId], rekick: false, run: runFn })
      if (!started) return
      expect(await waitForInFlight(20_000)).toBe(true)
    }
  }
  return { seen, drive }
}
async function newWorkstream(goal: string) {
  const origin = await createConversation({ title: `T2w origin ${goal}` })
  convIds.push(origin.id)
  const ws = await startWorkstream({ goal: `T2w ${goal}`, originConversationId: origin.id }, { kick: false })
  convIds.push(ws.conversationId)
  return ws
}
const segRuns = (convId: string) => useDb().select().from(agentRuns)
  .where(and(eq(agentRuns.conversationId, convId), eq(agentRuns.kind, 'workstream'))).orderBy(asc(agentRuns.createdAt))
const thread = (convId: string) => useDb().select().from(conversationMessages)
  .where(eq(conversationMessages.conversationId, convId)).orderBy(asc(conversationMessages.createdAt))

/** The manager's stopIf without Docker: guard → before → record the stop (the real one holds the
 *  workspace lock around all three — manager.test.ts). */
function guardedStop(stops: Array<[string, string]>) {
  return async (id: string, guard: () => Promise<boolean>, before: () => Promise<void>, why: string) => {
    if (!await guard()) return false
    await before()
    stops.push([id, why])
    await dbWorkspaceStore.setContainer(id, null, 'stopped')
    return true
  }
}

describe('watch × workstreams', () => {
  it('a segment that ends with a watch armed waits (paused, no budget); the watch resumes it as an event', async () => {
    met = false
    let watchId = ''
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      if (seg === 0) {
        step(ctx)
        const w = await callTool(ctx, 'watch', { command: 'test -f dist/ok', until: 'exit0', intervalSec: 600 })
        watchId = w.watchId
        yield { type: 'tool-result', name: 'watch', summary: 'watching' }
        yield { type: 'text-delta', text: 'Build started; waiting for it.' }
      } else {
        step(ctx)
        await callTool(ctx, 'finish_workstream', { summary: 'built' })
        yield { type: 'text-delta', text: 'Done.' }
      }
      yield { type: 'done' }
    })
    const ws = await newWorkstream('build-wait')
    await drive(ws.conversationId)
    expect(watchId).toBeTruthy()
    // Pre-loaded workspace toolset; a workspace of its own.
    expect(seen[0]!.toolsets).toContain('workspace')
    const [space] = await useDb().select().from(workspaces).where(eq(workspaces.workstreamId, ws.id))
    expect(space).toBeTruthy()
    const [w] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
    expect(w).toMatchObject({ workspaceId: space!.id, workstreamId: ws.id, state: 'armed' })

    let row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('paused')
    expect(row.attention).toMatchObject({ kind: 'paused', text: WAITING_FOR_WATCH, waitingForWatch: true })
    expect((await segRuns(ws.conversationId)).filter(r => r.status === 'queued' || r.status === 'running')).toEqual([])
    const stepsBefore = (row.used as { steps: number }).steps

    met = true
    expect(await rt.watches.poll(watchId)).toBe('met')
    row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('running')
    expect(row.attention).toBeNull()
    const runs = await segRuns(ws.conversationId)
    expect((runs.at(-1)!.input as { eventOrigin?: string }).eventOrigin).toBe('segment:watch')
    const [delivered] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
    expect(delivered!.deliveredAt).not.toBeNull()

    await drive(ws.conversationId)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.last).toMatch(/^Note: The watch you set is done: `test -f dist\/ok` exits 0/) // an event row, as the model sees one
    expect(seen[1]!.last).toContain('BUILD OK')
    expect(seen[1]!.last).toMatch(/Continue working on the goal\.$/)
    row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('done')
    expect((row.used as { steps: number }).steps).toBe(stepsBefore + 1) // waiting used no steps
    // In the log as an EVENT, never as something Tony said.
    const msgs = await thread(ws.conversationId)
    const ev = msgs.find(m => m.content.startsWith('The watch you set is done'))
    expect(ev).toMatchObject({ role: 'event', origin: 'segment:watch' })
  })

  it('final fix wave M1: a worker that dies while the result is being guarded leaves it UNDELIVERED — the next wake guards and delivers it', async () => {
    met = false
    let watchId = ''
    const { drive } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      if (seg === 0) {
        const w = await callTool(ctx, 'watch', { command: 'test -f dist/ok', until: 'exit0', intervalSec: 600 })
        watchId = w.watchId
        yield { type: 'tool-result', name: 'watch', summary: 'watching' }
      } else await callTool(ctx, 'finish_workstream', { summary: 'built' })
      yield { type: 'done' }
    })
    const ws = await newWorkstream('m1-crash-mid-guard')
    await drive(ws.conversationId, 1)
    expect((await getWorkstream(ws.id))!.state).toBe('paused')
    // The watch ends while the workstream waits — and the process "dies" inside the guard.
    const realGuard = watchDeliveryDeps.guard
    let guarded = 0
    watchDeliveryDeps.guard = async () => { guarded++; throw new Error('worker killed mid-guard') }
    met = true
    try {
      await rt.watches.poll(watchId).catch(() => 'threw')
      await wakeWorkstreamForWatch(ws.id).catch(() => 'threw')
    } finally { watchDeliveryDeps.guard = realGuard }
    expect(guarded).toBeGreaterThan(0)
    const [w] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
    expect(w).toMatchObject({ state: 'met', deliveredAt: null })        // never claimed: not lost
    expect((await segRuns(ws.conversationId)).filter(r => r.status === 'queued')).toEqual([])
    // The next worker's wake: guarded again, claimed, delivered.
    expect(await wakeWorkstreamForWatch(ws.id)).toBe('resumed')
    const [d] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
    expect(d!.deliveredAt).not.toBeNull()
    expect(((await segRuns(ws.conversationId)).at(-1)!.input as { eventOrigin?: string }).eventOrigin).toBe('segment:watch')
    await drive(ws.conversationId)
    expect((await getWorkstream(ws.id))!.state).toBe('done')
  })

  it('a watch that fires while a segment runs waits for that segment to end, then becomes the next one', async () => {
    met = false
    let watchId = ''
    let wakeWhileRunning = ''
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      if (seg === 0) {
        step(ctx)
        const w = await callTool(ctx, 'watch', { command: 'curl -s localhost:8000/health', until: 'exit0', intervalSec: 600 })
        watchId = w.watchId
        met = true
        await rt.watches.poll(watchId)
        const [r] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
        wakeWhileRunning = `${r!.state}/${r!.deliveredAt ? 'delivered' : 'pending'}`
        yield { type: 'tool-result', name: 'watch', summary: 'watching' }
        yield { type: 'text-delta', text: 'Meanwhile, writing docs.' }
      } else {
        step(ctx)
        await callTool(ctx, 'finish_workstream', { summary: 'served' })
        yield { type: 'done' }
        return
      }
      yield { type: 'done' }
    })
    const ws = await newWorkstream('fires-mid-segment')
    await drive(ws.conversationId)
    expect(wakeWhileRunning).toBe('met/pending') // not injected mid-segment
    expect(seen).toHaveLength(2)
    expect(seen[1]!.last).toMatch(/^Note: The watch you set is done: `curl -s localhost:8000\/health`/)
    expect((await getWorkstream(ws.id))!.state).toBe('done')
    const origins = (await segRuns(ws.conversationId)).map(r => (r.input as { eventOrigin?: string }).eventOrigin)
    expect(origins).toEqual(['segment:start', 'segment:watch'])
  })

  it('a finished workstream\'s armed watch is cancelled quietly at its next poll', async () => {
    met = false
    let watchId = ''
    const { drive } = harness(async function* (ctx) {
      step(ctx)
      watchId = (await callTool(ctx, 'watch', { command: 'false', until: 'exit0', intervalSec: 600 })).watchId
      await callTool(ctx, 'finish_workstream', { summary: 'gave up waiting' })
      yield { type: 'done' }
    })
    const ws = await newWorkstream('ends-first')
    await drive(ws.conversationId)
    expect((await getWorkstream(ws.id))!.state).toBe('done')
    // Its next poll (the first one may already have run after the finish) ends it without waking anyone.
    expect(['cancelled', 'gone']).toContain(await rt.watches.poll(watchId))
    const [r] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watchId))
    expect(r).toMatchObject({ state: 'cancelled', reason: 'its workstream has ended' })
    expect(r!.deliveredAt).not.toBeNull()
  })

  it('a chat (home) watch posts a note into its conversation when no turn is running there', async () => {
    const conv = await createConversation({ title: 'T2w chat watch' })
    convIds.push(conv.id)
    const [home] = await useDb().insert(workspaces).values({ kind: 'workstream', ns: NS }).returning() // stands in for home
    wsIds.push(home!.id)
    met = true
    const w = await rt.watches.create({ workspaceId: home!.id, workstreamId: null, conversationId: conv.id, command: 'test -f done', until: { kind: 'exit0' }, intervalSec: 600, timeoutMin: 5 })
    const note = await (async () => {
      for (let i = 0; i < 100; i++) {
        const m = (await thread(conv.id)).find(x => x.origin === 'workspace:watch:met')
        if (m) return m
        await new Promise(r => setTimeout(r, 50))
      }
      return null
    })()
    expect(note).toMatchObject({ role: 'event' })
    expect(note!.content).toMatch(/^The watch you set is done: `test -f done` exits 0/)
    const [r] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, w.id))
    expect(r!.deliveredAt).not.toBeNull()
  })

  it('I2: a watch over the workstream\'s lifetime cap pauses it for Tony — it stays paused after the segment, he is told once', async () => {
    let refusal: Record<string, any> = {}
    const { seen, drive } = harness(async function* (ctx) {
      step(ctx)
      refusal = await callTool(ctx, 'watch', { command: 'true', until: 'exit0' })
      yield { type: 'tool-result', name: 'watch', summary: 'refused' }
      yield { type: 'text-delta', text: 'Paused.' }
      yield { type: 'done' }
    })
    const ws = await newWorkstream('watch-cap')
    const space = await ensureWorkstreamWorkspace(ws.id)
    const long = new Date(Date.now() - 3600_000)
    await useDb().insert(workspaceWatches).values(Array.from({ length: WATCH_CAPS.perWorkstream }, () => ({
      workspaceId: space.id, workstreamId: ws.id, command: 'x', until: { kind: 'exit0' as const }, intervalSec: 30,
      createdAt: long, deadlineAt: new Date(long.getTime() + 60_000), endedAt: new Date(long.getTime() + 60_000), state: 'met' as const, deliveredAt: new Date()
    })))
    await drive(ws.conversationId)
    expect(refusal.error).toMatch(/already armed 10 watches.*paused for Tony/)
    expect(seen).toHaveLength(1) // no further segment
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('paused')
    expect(row.attention).toMatchObject({ kind: 'paused', text: expect.stringMatching(/watch limit/) })
    expect((await segRuns(ws.conversationId)).filter(r => r.status === 'queued' || r.status === 'running')).toEqual([])
    const notes = (await thread(ws.originConversationId!)).filter(m => m.content.startsWith('⚙ Workstream paused'))
    expect(notes).toHaveLength(1)
  })

  it('M5: the shell and watch caps hold under parallel creates (one lock per workspace in the DB)', async () => {
    const [w] = await useDb().insert(workspaces).values({ kind: 'workstream', ns: NS }).returning()
    wsIds.push(w!.id)
    const shells = await Promise.all(Array.from({ length: 12 }, (_, i) => dbShellStore.create(w!.id, `s${i}`, 8)))
    expect(shells.filter(Boolean)).toHaveLength(8)
    const watches = await Promise.all(Array.from({ length: 9 }, (_, i) => dbWatchStore.create({ workspaceId: w!.id, workstreamId: null, conversationId: null, command: `w${i}`, until: { kind: 'exit0' }, intervalSec: 30, timeoutMs: 60_000 }, WATCH_CAPS, new Date())))
    expect(watches.filter(x => !('refused' in x))).toHaveLength(WATCH_CAPS.perWorkspace)
  })

  it('M1: a chat turn in a FINISHED workstream\'s thread works in the home workspace; a live one in the workstream\'s', async () => {
    const ws = await newWorkstream('m1-route')
    const space = await ensureWorkstreamWorkspace(ws.id)
    const [run] = await useDb().insert(agentRuns).values({ conversationId: ws.conversationId, sessionKey: `thread:${ws.conversationId}`, trigger: 'user', profile: 'interactive', status: 'done', input: { text: 'x' } }).returning()
    expect(await resolveWorkspace(run!.id)).toMatchObject({ workspaceId: space.id, kind: 'workstream', workstreamId: ws.id })
    await patchWorkstream(ws.id, { state: 'done', finishedAt: new Date() })
    const ref = await resolveWorkspace(run!.id)
    expect(ref).toMatchObject({ kind: 'home', workstreamId: null, conversationId: ws.conversationId })
    expect(ref.workspaceId).not.toBe(space.id)
  })

  it('M2: tainting a workspace cancels its armed watches (owner told why) and records its running shells as stopped', async () => {
    const conv = await createConversation({ title: 'T2w taint' })
    convIds.push(conv.id)
    const [w] = await useDb().insert(workspaces).values({ kind: 'workstream', tainted: true, ns: NS }).returning()
    wsIds.push(w!.id)
    met = false
    const watch = await rt.watches.create({ workspaceId: w!.id, workstreamId: null, conversationId: conv.id, command: 'sleep 1', until: { kind: 'exit0' }, intervalSec: 600, timeoutMin: 5 })
    if ('refused' in watch) throw new Error('refused')
    const shell = await dbShellStore.create(w!.id, 'sleep 99', 8)
    await runtimeHooks(rt).onTainted(w!.id)
    await runtimeHooks(rt).onTainted(w!.id) // idempotent
    const [wr] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watch.id))
    expect(wr).toMatchObject({ state: 'cancelled', reason: TAINTED_REASON })
    expect(wr!.resultText).toMatch(/cancelled: `sleep 1` — this workspace's network was turned off/)
    const { workspaceShells } = await import('@mymind/core/db/schema')
    const [sr] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, shell!.id))
    expect(sr).toMatchObject({ state: 'killed', reason: `stopped: ${TAINTED_REASON}` })
  })

  it('final fix wave: a watch-cap pause never overwrites a pending ask_tony question — the note goes into the thread', async () => {
    const ws = await newWorkstream('pause-vs-question')
    const question = { kind: 'question', text: 'Which branch?' }
    await patchWorkstream(ws.id, { state: 'attention', attention: question as never })
    expect(await pauseWorkstreamForTony(undefined, ws.id, 'It reached its watch limit')).toBe(true)
    const after = (await getWorkstream(ws.id))!
    expect(after.state).toBe('attention')
    expect(after.attention).toMatchObject(question)
    const msgs = await thread(ws.conversationId)
    expect(msgs.at(-1)).toMatchObject({ role: 'event', content: expect.stringMatching(/Paused for you — It reached its watch limit/) })
    // A running one is paused as before.
    await patchWorkstream(ws.id, { state: 'running', attention: null })
    expect(await pauseWorkstreamForTony(undefined, ws.id, 'limit')).toBe(true)
    expect((await getWorkstream(ws.id))!).toMatchObject({ state: 'paused', attention: { kind: 'paused', text: 'limit' } })
  })

  it('I2: a workstream that ends tears its workspace down at once (shells killed, watches cancelled quietly, container stopped); the minute tick catches the rest', async () => {
    const stops: Array<[string, string]> = []
    const mgr = { ...fakeManager, stopIf: guardedStop(stops) } as unknown as SandboxManager
    const local = createWorkspaceRuntime(mgr)
    const ws = await newWorkstream('teardown')
    const space = await ensureWorkstreamWorkspace(ws.id)
    await dbWorkspaceStore.setContainer(space.id, 'c-teardown', 'running')
    const shell = await dbShellStore.create(space.id, 'python -m http.server', 8)
    met = false
    const watch = await local.watches.create({ workspaceId: space.id, workstreamId: ws.id, conversationId: null, command: 'false', until: { kind: 'exit0' }, intervalSec: 600, timeoutMin: 60 })
    if ('refused' in watch) throw new Error('refused')
    // The worker installs the hook at start (startWorkspaceRuntime) — here on this runtime.
    setWorkspaceRuntime(local)
    const started = startWorkspaceRuntime({ info: () => {}, warn: () => {}, error: () => {} })
    try {
      expect(await finishedWorkstreamsWithLiveWorkspaces()).not.toContain(ws.id)
      await patchWorkstream(ws.id, { state: 'done', finishedAt: new Date() }, ['queued', 'running'])
      for (let i = 0; i < 50 && !stops.length; i++) await new Promise(r => setTimeout(r, 20))
      expect(stops).toEqual([[space.id, 'killed: its workstream has ended']])
      const { workspaceShells } = await import('@mymind/core/db/schema')
      const [sr] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, shell!.id))
      expect(sr).toMatchObject({ state: 'killed', reason: 'killed: its workstream has ended' })
      const [wr] = await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watch.id))
      expect(wr).toMatchObject({ state: 'cancelled', reason: 'its workstream has ended' })
      expect(wr!.deliveredAt).not.toBeNull() // nobody told
      // Backstop: a finished workstream whose workspace still has a live row (ended elsewhere).
      await dbShellStore.create(space.id, 'sleep 99', 8)
      expect(await finishedWorkstreamsWithLiveWorkspaces()).toContain(ws.id)
      await started.onTick()
      expect(await finishedWorkstreamsWithLiveWorkspaces()).not.toContain(ws.id)
      expect(await teardownWorkstreamWorkspace(local, ws.id)).toBe(true) // idempotent
    } finally {
      started.stop()
      local.watches.stop()
      setWorkspaceRuntime(rt)
    }
  })

  it('I7: a workstream workspace expires 30 days after its workstream FINISHED; a resumed (unfinished) one never does', async () => {
    const before = new Date(Date.now() - 30 * 24 * 60 * 60_000)
    const old = await newWorkstream('i7-old')
    const fresh = await newWorkstream('i7-fresh')
    const live = await newWorkstream('i7-live')
    const [a, b, c] = [await ensureWorkstreamWorkspace(old.id), await ensureWorkstreamWorkspace(fresh.id), await ensureWorkstreamWorkspace(live.id)]
    await patchWorkstream(old.id, { state: 'cancelled', finishedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) })
    await patchWorkstream(fresh.id, { state: 'done', finishedAt: new Date(Date.now() - 29 * 24 * 60 * 60_000) })
    const ids = (await dbWorkspaceStore.listExpired(before)).map(r => r.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(b.id)
    expect(ids).not.toContain(c.id)
    // Resumed: no finished_at → no longer expired.
    await patchWorkstream(old.id, { state: 'running', finishedAt: null })
    expect((await dbWorkspaceStore.listExpired(before)).map(r => r.id)).not.toContain(a.id)
    // Another namespace's rows are never swept from here (the dev worker vs a test run).
    setBusNs('t82-other-ns')
    try { expect((await dbWorkspaceStore.listExpired(new Date())).map(r => r.id)).not.toContain(b.id) } finally { setBusNs(NS) }
  })

  it('follow-up N4: a workstream resumed between "it ended" and the teardown keeps its watch, its shells and its sandbox', async () => {
    const stops: Array<[string, string]> = []
    const local = createWorkspaceRuntime({ ...fakeManager, stopIf: guardedStop(stops) } as unknown as SandboxManager)
    const ws = await newWorkstream('n4-resume')
    const space = await ensureWorkstreamWorkspace(ws.id)
    await dbWorkspaceStore.setContainer(space.id, 'c-n4', 'running')
    await patchWorkstream(ws.id, { state: 'cancelled', finishedAt: new Date() })
    // The resume lands before the teardown acts (resumeWorkstream: cancelled → running).
    await patchWorkstream(ws.id, { state: 'running', finishedAt: null })
    const shell = await dbShellStore.create(space.id, 'npm run build', 8)
    met = false
    const watch = await local.watches.create({ workspaceId: space.id, workstreamId: ws.id, conversationId: null, command: 'false', until: { kind: 'exit0' }, intervalSec: 600, timeoutMin: 60 })
    if ('refused' in watch) throw new Error('refused')
    try {
      expect(await teardownWorkstreamWorkspace(local, ws.id)).toBe(false)
      expect(stops).toEqual([])
      const { workspaceShells } = await import('@mymind/core/db/schema')
      expect((await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, shell!.id)))[0]!.state).toBe('running')
      expect((await useDb().select().from(workspaceWatches).where(eq(workspaceWatches.id, watch.id)))[0]).toMatchObject({ state: 'armed', deliveredAt: null })
      expect((await dbWorkspaceStore.get(space.id))!.state).toBe('running')
    } finally { local.watches.stop() }
  })
})
