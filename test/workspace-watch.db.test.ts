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
import { startWorkstream, WAITING_FOR_WATCH } from '@mymind/core/lib/agent/workstreams/loop'
import { getWorkstream } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import { createWorkspaceRuntime, setWorkspaceRuntime, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { WATCH_POLL_SCRIPT } from '@mymind/core/lib/sandbox/fs-ops'
import type { SandboxManager, SandboxExecResult } from '@mymind/core/lib/sandbox/manager'
import type { RunAgentCtx, AgentMessage, AgentEvent } from '@mymind/core/lib/agent/run'

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
  const ws = await startWorkstream({ goal: `T2w ${goal}`, originConversationId: origin.id }, { kick: false, cap: 1000 })
  convIds.push(ws.conversationId)
  return ws
}
const segRuns = (convId: string) => useDb().select().from(agentRuns)
  .where(and(eq(agentRuns.conversationId, convId), eq(agentRuns.kind, 'workstream'))).orderBy(asc(agentRuns.createdAt))
const thread = (convId: string) => useDb().select().from(conversationMessages)
  .where(eq(conversationMessages.conversationId, convId)).orderBy(asc(conversationMessages.createdAt))

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
    const [home] = await useDb().insert(workspaces).values({ kind: 'workstream' }).returning() // stands in for home
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
})
