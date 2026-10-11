// Cycle 81 Task 5 — the workstream state machine (spec §5) through the REAL queue → runner → loop
// path: segments are real agent_runs rows (kind 'workstream'), claimed by a scoped pump and executed
// by runTurn with a fake model (`runAgent`) that drives the segment hooks (onStep / shouldStop) and
// calls the real workstream tools. The dev DB is shared: every pump is scoped to this file's
// conversations, kicks go to this file's bus namespace (execution mode 'remote'), and every outbound
// notification (iMessage text, iMessage approval prompt) is captured by `workstreamNotifyDeps`.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, beforeAll, afterEach, beforeEach } from 'vitest'
import { vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// gmail_send (C1 test) runs for real against a fake Gmail: one connection, no network.
vi.mock('@mymind/core/lib/google/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mymind/core/lib/google/connections')>()),
  listConnections: vi.fn(async () => [{ id: 'conn-work', accountId: 'acc', userId: 'u', googleSub: 's', provider: 'google', label: 'work', email: 'tony@work.com', status: 'ok', lastError: null }]),
  touchConnection: vi.fn(async () => {}),
  markReconnect: vi.fn(async () => {})
}))

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, channelApprovals, conversationMessages, conversations, runEvents, workerCommands, workspaces, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { _resumeClaimingForTests, enqueue, pumpOnce, setExecutionMode, stopClaiming, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { recoverStale } from '@mymind/core/lib/agent/runtime/recover'
import { decideBusApproval, pendingBusApprovals } from '@mymind/core/lib/agent/runtime/bus-approvals'
import { openApprovalFrames, pruneRunEvents } from '@mymind/core/lib/bus/events'
import { pruneHandledCommands } from '@mymind/core/lib/bus/commands'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import { createConversation, appendMessages } from '@mymind/core/services/conversations'
import { controlWorkstream, nudgeWaitingWorkstreams, onSegmentHandlerFailed, restoreParkedApprovals, routeInboundAnswer, startWorkstream, sweepStalledWorkstreams, WorkstreamCapError } from '@mymind/core/lib/agent/workstreams/loop'
import { pushSteer } from '@mymind/core/lib/agent/runtime/inbox'
import { abortRun } from '@mymind/core/lib/agent/runtime/aborts'
import { replayAgentAction } from '@mymind/core/lib/agent/runtime/replay'
import { getWorkstream, patchWorkstream } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import { startWorkstreamTool } from '@mymind/core/lib/agent/tools/workstreams'
import { subscribeChanges } from '@mymind/core/utils/live-bus'
import type { RunAgentCtx, AgentMessage, AgentEvent } from '@mymind/core/lib/agent/run'
import type { ApprovalRequest } from '@mymind/core/lib/agent/types'
import type { LiveEvent } from '@mymind/core/shared/types/live'
import { buildAiTools } from '@mymind/core/lib/agent/ai-tools'
import { gmailDeps, gmailSendTool } from '@mymind/core/lib/agent/tools/gmail'
import { fakeFetch } from '@mymind/core/lib/google/fake-fetch'
const G = '/gmail/v1/users/me'

const NS = `t5-ws-${process.pid}`
const convIds: string[] = []
const realNotify = { ...workstreamNotifyDeps }
const texts: string[] = []
const iApprovals: Array<{ req: ApprovalRequest; signal: AbortSignal }> = []
let away = true

beforeAll(() => { setBusNs(NS); setExecutionMode('remote') })
beforeEach(() => {
  texts.length = 0
  iApprovals.length = 0
  away = true
  workstreamNotifyDeps.isAway = async () => away
  workstreamNotifyDeps.text = async (t) => { texts.push(t); return [] }
  // The iMessage prompt never answers by itself: it resolves only when withdrawn (the card won).
  workstreamNotifyDeps.imessageApproval = (_runId, req, signal) => {
    iApprovals.push({ req, signal })
    return new Promise(res => signal.addEventListener('abort', () => res({ approved: false }), { once: true }))
  }
})
afterEach(() => { delete process.env.APPROVAL_TIMEOUT_MS })
afterAll(async () => {
  Object.assign(workstreamNotifyDeps, realNotify)
  const db = useDb()
  // Cycle 82: every workstream started here got a workspace row (in this file's bus namespace) —
  // remove them, or deleting the workstreams below leaves orphans (workstream_id set null).
  await db.delete(workspaces).where(eq(workspaces.ns, NS))
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

// ── harness ─────────────────────────────────────────────────────────────────────────────────

type Script = (ctx: RunAgentCtx, messages: AgentMessage[], seg: number) => AsyncGenerator<AgentEvent>
const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One model step the way runAgent reports it: usage to onStep. */
function step(ctx: RunAgentCtx, i = 10, o = 5): void { ctx.onStep?.({ inputTokens: i, outputTokens: o }) }

/** Call a tool of the segment's registry the way buildAiTools would (runId on the context). */
async function callTool(ctx: RunAgentCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const t = ctx.profile?.tools.find(x => x.name === name)
  if (!t) throw new Error(`tool ${name} is not in this run's registry`)
  return (await t.handler(args, { signal: ctx.signal, runId: ctx.runId, requestApproval: ctx.requestApproval })).result
}

interface Seen { runId?: string; tools: string[]; maxSteps?: number; final?: string; last: string }
function harness(script: Script) {
  const seen: Seen[] = []
  const runAgent = (messages: AgentMessage[], ctx: RunAgentCtx) => {
    const n = seen.length
    seen.push({ runId: ctx.runId, tools: (ctx.profile?.tools ?? []).map(t => t.name), maxSteps: ctx.maxSteps, final: ctx.workstream?.final?.reason, last: String(messages[messages.length - 1]?.content ?? '') })
    return script(ctx, messages, n)
  }
  const runFn = (r: AgentRun) => runTurn(r, { runAgent: runAgent as never, assemble: noAssemble as never, unavailableToolsets: async () => [] })
  /** Pump the workstream's thread until nothing is runnable (or `rounds`), awaiting each segment. */
  const drive = async (convId: string, rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      const started = await pumpOnce({ onlyConversations: [convId], rekick: false, run: runFn })
      if (!started) return
      expect(await waitForInFlight(20_000)).toBe(true)
    }
  }
  return { seen, runFn, drive }
}

async function newWorkstream(goal: string, budget?: { maxSteps?: number; maxWallMs?: number }) {
  const origin = await createConversation({ title: `T5 origin ${goal}` })
  convIds.push(origin.id)
  // cap: the active-workstream cap counts every workstream on the shared dev DB; the cap test sets its own.
  const ws = await startWorkstream({ goal: `T5 ${goal}`, originConversationId: origin.id, budget }, { kick: false, cap: 1000 })
  convIds.push(ws.conversationId)
  return { ws, origin: origin.id }
}

const segRuns = (convId: string) => useDb().select().from(agentRuns)
  .where(and(eq(agentRuns.conversationId, convId), eq(agentRuns.kind, 'workstream'))).orderBy(asc(agentRuns.createdAt))
const activeSegs = async (convId: string) => (await segRuns(convId)).filter(r => r.status === 'queued' || r.status === 'running')
const thread = (convId: string) => useDb().select().from(conversationMessages)
  .where(eq(conversationMessages.conversationId, convId)).orderBy(asc(conversationMessages.createdAt))
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(20)
  }
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe('workstreams', () => {
  it('segments advance until finish_workstream: summary + link posted to the origin chat, Tony texted when away, budget accounted', async () => {
    const changes: LiveEvent[] = []
    const off = subscribeChanges(e => { if (e.resource === 'workstream') changes.push(e) })
    let refused: unknown
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      if (seg === 0) {
        // No recursion: start_workstream is not in a workstream's registry, and refuses anyway.
        refused = (await startWorkstreamTool.handler({ goal: 'nested' }, { signal: ctx.signal, runId: ctx.runId })).result
        // Should it ever succeed (a regression), its thread is still this file's to clean up.
        const leaked = (refused as { conversationId?: string }).conversationId
        if (leaked) convIds.push(leaked)
        for (let i = 0; i < 3 && !ctx.shouldStop?.(); i++) step(ctx)
        yield { type: 'tool-result', name: 'search_memories', summary: 'found 2' } // a real tool call: not idle
        yield { type: 'text-delta', text: 'PROGRESS-ONE' }
      } else {
        step(ctx, 20, 7)
        await callTool(ctx, 'finish_workstream', { summary: 'SUMMARY-A: three options compared' })
        yield { type: 'text-delta', text: 'Done.' }
      }
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('compare')
    expect(ws.state).toBe('queued')
    await drive(ws.conversationId)
    off()

    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('done')
    expect(row.summary).toBe('SUMMARY-A: three options compared')
    expect(row.used).toMatchObject({ steps: 4, inputTokens: 50, outputTokens: 22 })
    expect(row.finishedAt).not.toBeNull()
    const runs = await segRuns(ws.conversationId)
    expect(runs.map(r => r.status)).toEqual(['done', 'done'])
    expect(await activeSegs(ws.conversationId)).toEqual([])
    // Tools: no start_workstream inside; finish/ask only here.
    for (const s of seen) {
      expect(s.tools).not.toContain('start_workstream')
      expect(s.tools).toEqual(expect.arrayContaining(['finish_workstream', 'ask_tony']))
    }
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/cannot start another workstream/) })
    expect((await useDb().select().from(workstreams).where(like_goal('T5 nested'))).length).toBe(0)
    // The log: the start prompt and the continuation are event rows, the model's text persisted.
    const msgs = await thread(ws.conversationId)
    expect(msgs[0]).toMatchObject({ role: 'event', origin: 'segment:start' })
    expect(msgs[0]!.content).toContain('Goal: T5 compare')
    expect(msgs.some(m => m.role === 'assistant' && m.content.includes('PROGRESS-ONE'))).toBe(true)
    expect(msgs.some(m => m.role === 'event' && m.origin === 'segment:continue')).toBe(true)
    expect(seen[1]!.last).toMatch(/Continue working on the goal/)
    // Origin chat: an event row with the summary and the link.
    const notes = (await thread(origin)).filter(m => m.origin === `workstream:${ws.id}`)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain('SUMMARY-A')
    expect(notes[0]!.content).toContain(`/workstreams/${ws.id}`)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(`/workstreams/${ws.id}`)
    // Live resource on every state/used change.
    expect(changes.filter(c => c.id === ws.id).length).toBeGreaterThanOrEqual(5)
  })

  it('step budget used up → one final tool-free summary step, then failed with the reason; nothing after', async () => {
    const { seen, drive } = harness(async function* (ctx) {
      if (ctx.workstream?.final) { yield { type: 'text-delta', text: 'SUMMARY-B so far' }; yield { type: 'done' }; return }
      for (let i = 0; i < (ctx.maxSteps ?? 40) && !ctx.shouldStop?.(); i++) step(ctx)
      yield { type: 'text-delta', text: 'working' }
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('budget-steps', { maxSteps: 5 })
    await drive(ws.conversationId)
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('failed')
    expect(row.failureReason).toMatch(/step budget used up \(5 of 5 steps\)/)
    expect(row.summary).toBe('SUMMARY-B so far')
    expect(seen).toHaveLength(2)
    expect(seen[0]!.maxSteps).toBe(5)                  // segment cap = what is left of the budget
    expect(seen[1]).toMatchObject({ maxSteps: 1, final: expect.stringMatching(/step budget/) })
    // The loop queued the summary step itself (not a plain continuation that happened to start final).
    expect((await segRuns(ws.conversationId)).map(r => (r.input as { eventOrigin?: string }).eventOrigin)).toEqual(['segment:start', 'segment:budget'])
    expect(await activeSegs(ws.conversationId)).toEqual([])
    expect((await thread(origin)).some(m => m.origin === `workstream:${ws.id}` && m.content.includes('SUMMARY-B'))).toBe(true)
  })

  it('wall budget used up (active time) → stops after the current step, final summary, failed', async () => {
    const { seen, drive } = harness(async function* (ctx) {
      if (ctx.workstream?.final) { yield { type: 'text-delta', text: 'SUMMARY-C' }; yield { type: 'done' }; return }
      for (let i = 0; i < 40 && !ctx.shouldStop?.(); i++) { await sleep(60); step(ctx) }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('budget-wall')
    await patchWorkstream(ws.id, { budget: { maxSteps: 400, maxWallMs: 250 } })
    await drive(ws.conversationId)
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('failed')
    expect(row.failureReason).toMatch(/time budget used up/)
    expect(row.summary).toBe('SUMMARY-C')
    const used = row.used as { steps: number; wallMs: number }
    expect(used.wallMs).toBeGreaterThanOrEqual(250)
    expect(used.steps).toBeGreaterThanOrEqual(3)
    expect(used.steps).toBeLessThanOrEqual(6)
    expect(seen).toHaveLength(2)
  })

  it('ask_tony → attention + notification, no further segment; his reply in the thread starts the next one', async () => {
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      if (seg === 0) await callTool(ctx, 'ask_tony', { question: 'Synology or QNAP?' })
      else await callTool(ctx, 'finish_workstream', { summary: 'went with it' })
      // The model would go on stepping; the segment must stop right after the step that asked/finished.
      for (let i = 0; i < 5 && !ctx.shouldStop?.(); i++) step(ctx)
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('ask')
    await drive(ws.conversationId)
    let row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('attention')
    expect(row.attention).toEqual({ kind: 'question', text: 'Synology or QNAP?', notifiedAt: expect.any(Number) })
    expect(await activeSegs(ws.conversationId)).toEqual([])
    expect(seen).toHaveLength(1)
    expect(texts.join('\n')).toContain('Synology or QNAP?')
    expect((await thread(origin)).some(m => m.origin === `workstream:${ws.id}` && m.content.includes('Synology or QNAP?'))).toBe(true)

    const r = await enqueue({ sessionKey: `thread:${ws.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'Synology', modality: 'text' } }, { kick: false })
    expect(r).toMatchObject({ steered: false, conversationId: ws.conversationId })
    const [next] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(next).toMatchObject({ kind: 'workstream', status: 'queued' })
    row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('running')
    expect(row.attention).toBeNull()
    await drive(ws.conversationId)
    expect(seen[1]!.last).toBe('Synology')
    row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('done')
    expect((row.used as { steps: number }).steps).toBe(2)   // one step each: ask, then finish
    // His reply is a user row in the log.
    expect((await thread(ws.conversationId)).some(m => m.role === 'user' && m.content === 'Synology')).toBe(true)
  })

  it('an approval waits with NO timeout (attention {approval}), the card shows in the origin chat too, and the decision resumes the SAME run', async () => {
    process.env.APPROVAL_TIMEOUT_MS = '50' // a chat card would auto-deny here
    let answer: { approved: boolean } | undefined
    const req: ApprovalRequest = { tool: 'exec', command: `t5-approval-${process.pid}`, proposedPattern: 'x', allowlistable: false }
    const { seen, runFn } = harness(async function* (ctx) {
      step(ctx)
      answer = await ctx.requestApproval!(req)
      step(ctx)
      await callTool(ctx, 'finish_workstream', { summary: 'approved and done' })
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('approval')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    const row = await until(async () => { const r = await getWorkstream(ws.id); return (r?.attention as { kind?: string } | null)?.kind === 'approval' ? r : null })
    const att = row.attention as { kind: string; text: string; requestId: string }
    expect(row.state).toBe('attention')
    expect(att.text).toContain(`t5-approval-${process.pid}`)
    const t0 = Date.now()
    await sleep(500)                                         // 10× the chat timeout
    const runId = seen[0]!.runId!
    expect(pendingBusApprovals(runId)).toEqual([att.requestId])
    expect(answer).toBeUndefined()
    // The card: on the workstream thread and mirrored into the chat it was started from.
    expect((await openApprovalFrames(ws.conversationId)).map(f => f.frame.requestId)).toEqual([att.requestId])
    expect((await openApprovalFrames(origin)).map(f => f.frame.requestId)).toEqual([att.requestId])
    // Away: the iMessage prompt is out, racing the card.
    expect(iApprovals).toHaveLength(1)
    expect(iApprovals[0]!.req.command).toBe(req.command)

    expect(decideBusApproval({ requestId: att.requestId, approved: true })).toBe(true)
    const waited = Date.now() - t0
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(answer).toEqual({ approved: true })
    expect(iApprovals[0]!.signal.aborted).toBe(true)        // the iMessage prompt is withdrawn
    const done = (await getWorkstream(ws.id))!
    expect(done.state).toBe('done')
    expect(done.attention).toBeNull()
    expect((await segRuns(ws.conversationId)).map(r => r.id)).toEqual([runId]) // same run, no new segment
    expect(await openApprovalFrames(origin)).toEqual([])
    // Attention time is not budget time.
    expect((done.used as { wallMs: number }).wallMs).toBeLessThan(waited)
  })

  it('cancel stops after the current step — not mid-step, no further segment', async () => {
    let stepStarted!: () => void
    const started = new Promise<void>(r => { stepStarted = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let steps = 0
    const { runFn } = harness(async function* (ctx) {
      for (let i = 0; i < 40 && !ctx.shouldStop?.(); i++) {
        if (i === 1) { stepStarted(); await gate }
        steps++
        step(ctx)
      }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('cancel')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await started
    // `used` is persisted every step, while the segment is still running (a crash keeps it).
    await until(async () => ((await getWorkstream(ws.id))?.used as { steps?: number } | undefined)?.steps === 1, 3_000)
    const dto = await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(dto.state).toBe('running')                       // the step in flight finishes first
    release()
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(steps).toBe(2)
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('cancelled')
    expect((row.used as { steps: number }).steps).toBe(2)
    expect(await activeSegs(ws.conversationId)).toEqual([])
  })

  it('cancel with only a queued segment is immediate, and the segment never runs', async () => {
    const { seen, drive } = harness(async function* () { yield { type: 'done' } })
    const { ws } = await newWorkstream('cancel-queued')
    expect((await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })).state).toBe('cancelled')
    expect((await segRuns(ws.conversationId)).map(r => r.status)).toEqual(['aborted'])
    await drive(ws.conversationId)
    expect(seen).toHaveLength(0)
  })

  it('a worker killed mid-segment: recovery re-enqueues from the persisted thread with the budget LEFT (persisted used)', async () => {
    const { seen, drive } = harness(async function* (ctx) {
      step(ctx)
      await callTool(ctx, 'finish_workstream', { summary: 'resumed fine' })
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('crash', { maxSteps: 10 })
    // The dead worker: it claimed the segment, persisted 7 steps of `used` and some of the log, then died.
    const [r1] = await segRuns(ws.conversationId)
    await useDb().update(agentRuns).set({ status: 'running', owner: 'dead-boot', claimedAt: sql`now() - interval '5 minutes'`, aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r1!.id))
    await patchWorkstream(ws.id, { state: 'running', used: { steps: 7, wallMs: 1000, inputTokens: 70, outputTokens: 35, costUsd: 0 } })
    await appendMessages(ws.conversationId, [{ role: 'assistant', content: 'PROGRESS-BEFORE-CRASH', modality: 'text' }])

    expect(await recoverStale({ onlyConversations: [ws.conversationId] })).toBe(1)
    const after = await segRuns(ws.conversationId)
    expect(after.map(r => r.status)).toEqual(['interrupted', 'queued'])
    expect(after[1]!.input).toMatchObject({ eventOrigin: 'segment:restarted' })
    expect((await getWorkstream(ws.id))!).toMatchObject({ lastOutcome: 'interrupted', failures: 0 })
    await drive(ws.conversationId)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.maxSteps).toBe(3)                       // 10 − 7 persisted
    const msgs = await thread(ws.conversationId)
    expect(msgs.some(m => m.content === 'PROGRESS-BEFORE-CRASH')).toBe(true)
    expect(msgs.some(m => m.origin === 'runtime:restart')).toBe(true)
    expect(msgs.some(m => m.origin === 'segment:restarted')).toBe(true)
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('done')
    expect((row.used as { steps: number }).steps).toBe(8)
  })

  it('3 consecutive failed segments → failed, never a re-enqueue loop', async () => {
    const { seen, drive } = harness(async function* (ctx) {
      step(ctx)
      throw new Error('model exploded')
    })
    const { ws, origin } = await newWorkstream('fail')
    await drive(ws.conversationId, 10)
    expect(seen).toHaveLength(3)
    expect((await segRuns(ws.conversationId)).map(r => r.status)).toEqual(['failed', 'failed', 'failed'])
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('failed')
    expect(row.failureReason).toMatch(/3 segments failed in a row \(last: model exploded\)/)
    expect(await activeSegs(ws.conversationId)).toEqual([])
    expect((await thread(origin)).some(m => m.origin === `workstream:${ws.id}`)).toBe(true)
    // The stalled sweep leaves a failed workstream alone.
    expect(await sweepStalledWorkstreams({ onlyConversations: [ws.conversationId], graceMs: 0 })).toBe(0)
  })

  it('a crash-interrupted segment counts as a failure only when it recurs', async () => {
    const { ws } = await newWorkstream('crash-loop')
    const kill = async () => {
      const [q] = await activeSegs(ws.conversationId)
      await useDb().update(agentRuns).set({ status: 'running', owner: 'dead-boot', aliveAt: sql`now() - interval '5 minutes'`, claimedAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, q!.id))
      await recoverStale({ onlyConversations: [ws.conversationId] })
      return (await getWorkstream(ws.id))!
    }
    expect(await kill()).toMatchObject({ failures: 0, state: 'running' })
    expect(await kill()).toMatchObject({ failures: 1, state: 'running' })
    expect(await kill()).toMatchObject({ failures: 2, state: 'running' })
    const last = await kill()
    expect(last).toMatchObject({ failures: 3, state: 'failed' })
    expect(await activeSegs(ws.conversationId)).toEqual([])
  })

  it('drain: a running segment yields after its current step and queues its successor', async () => {
    let first!: () => void
    const firstDone = new Promise<void>(r => { first = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { runFn } = harness(async function* (ctx) {
      for (let i = 0; i < 40 && !ctx.shouldStop?.(); i++) {
        step(ctx)
        if (i === 0) { first(); await gate }
      }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('drain')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    await firstDone
    stopClaiming()                                          // the worker's SIGTERM drain, step 1
    try {
      release()
      expect(await waitForInFlight(10_000)).toBe(true)
    } finally { _resumeClaimingForTests() }
    const runs = await segRuns(ws.conversationId)
    expect(runs.map(r => r.status)).toEqual(['done', 'queued'])
    expect(runs[1]!.input).toMatchObject({ eventOrigin: 'segment:restarted' })
    expect((await getWorkstream(ws.id))!.used).toMatchObject({ steps: 1 })
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('a stalled workstream (no segment) gets its next one from the sweep', async () => {
    const { ws } = await newWorkstream('stalled')
    await useDb().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` }).where(eq(agentRuns.conversationId, ws.conversationId))
    await useDb().update(workstreams).set({ state: 'running', updatedAt: sql`now() - interval '2 minutes'` }).where(eq(workstreams.id, ws.id))
    expect(await sweepStalledWorkstreams({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect((await activeSegs(ws.conversationId)).map(r => (r.input as { eventOrigin?: string }).eventOrigin)).toEqual(['segment:restarted'])
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })
})

// ── fix round 1 (review task-5-review.md) ─────────────────────────────────────────────────────

const req1 = (): ApprovalRequest => ({ tool: 'exec', command: `t5-park-${process.pid}`, proposedPattern: 'x', allowlistable: false })
async function waitForApproval(wsId: string) {
  return until(async () => {
    const r = await getWorkstream(wsId)
    const a = r?.attention as { kind?: string; requestId?: string } | null
    return a?.kind === 'approval' && a.requestId && pendingBusApprovals().includes(a.requestId) ? r : null
  })
}
/** A dead worker's 'running' row for the workstream's current segment (or a fresh one). */
async function killSegment(convId: string, runId?: string) {
  const id = runId ?? (await useDb().insert(agentRuns).values({
    conversationId: convId, sessionKey: `thread:${convId}`, trigger: 'user', profile: 'interactive', kind: 'workstream', input: { text: 'x', modality: 'text' }
  }).returning())[0]!.id
  await useDb().update(agentRuns).set({ status: 'running', owner: 'dead-boot', claimedAt: sql`now() - interval '5 minutes'`, aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, id))
  return id
}

describe('fix round 1', () => {
  it('C1: a card parked across a restart is WITHDRAWN (it can never be approved); the re-issued gmail_send raises a FRESH card from the live draft, and only that approval sends', async () => {
    const draft = { body: 'BODY-V1', msg: 'm-v1' }
    const sent: Array<{ body: string }> = []
    gmailDeps.google = {
      fetch: fakeFetch({
        [`GET ${G}/drafts/d1`]: () => ({ json: { id: 'd1', message: { id: draft.msg, threadId: 't1', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'tony@work.com' }, { name: 'To', value: 'ann@a.com' }, { name: 'Subject', value: 'Hi' }], body: { data: Buffer.from(draft.body).toString('base64url') } } } } }),
        [`POST ${G}/drafts/send`]: () => { sent.push({ body: draft.body }); return { json: { id: 'sent-1', threadId: 't1' } } }
      }),
      token: async () => 't-work',
      refresh: async () => { throw new Error('no refresh in tests') },
      sleep: async () => {}
    }
    const results: unknown[] = []
    const { runFn } = harness(async function* (ctx) {
      step(ctx)
      const set = buildAiTools([gmailSendTool], { signal: ctx.signal, requestApproval: ctx.requestApproval, runId: ctx.runId, onEvent: () => {} })
      results.push(await (set.gmail_send!.execute as (i: unknown, o: { toolCallId: string }) => Promise<unknown>)({ account: 'work', draftId: 'd1' }, { toolCallId: 'c1' }))
      yield { type: 'tool-result', name: 'gmail_send', summary: 'x' }
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('c1-gmail')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    const a = (await waitForApproval(ws.id)).attention as { requestId: string }
    const shown = await until(async () => { const f = await openApprovalFrames(origin); return f.length ? f : null })
    expect(shown.map(f => f.frame.command)).toEqual([expect.stringContaining('BODY-V1')])
    stopClaiming()
    try { expect(await waitForInFlight(10_000)).toBe(true) } finally { _resumeClaimingForTests() }
    expect(iApprovals[0]!.signal.reason).toBe('withdrawn')

    // The next worker withdraws the old card and resumes with a note — it never re-shows it.
    expect(await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect(await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })).toBe(0)
    expect(decideBusApproval({ requestId: a.requestId, approved: true })).toBe(false)  // no decision path
    expect(await openApprovalFrames(ws.conversationId)).toEqual([])
    expect(await openApprovalFrames(origin)).toEqual([])
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', attention: null, failures: 0 })
    const [note] = await activeSegs(ws.conversationId)
    expect(note!.input).toMatchObject({ eventOrigin: 'segment:approval-lost', text: expect.stringMatching(/did NOT run/) })
    expect(sent).toEqual([])

    // Tony (or the model) edits the draft; the re-issued call is a NEW card with the NEW content.
    draft.body = 'BODY-V2'
    draft.msg = 'm-v2'
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    const b = await until(async () => {
      const r = await getWorkstream(ws.id)
      const att = r?.attention as { kind?: string; requestId?: string } | null
      return att?.kind === 'approval' && att.requestId !== a.requestId && pendingBusApprovals().includes(att.requestId!) ? att : null
    })
    const cards = await until(async () => { const f = await openApprovalFrames(ws.conversationId); return f.length ? f : null })
    expect(cards.map(c => c.frame.requestId)).toEqual([b.requestId])
    expect(cards[0]!.frame.command).toContain('BODY-V2')
    expect(cards[0]!.frame.command).not.toContain('BODY-V1')
    expect(sent).toEqual([])                                   // nothing went out without the fresh approval
    expect(decideBusApproval({ requestId: b.requestId!, approved: true })).toBe(true)
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(sent).toEqual([{ body: 'BODY-V2' }])
    expect(results.at(-1)).toMatchObject({ sent: true })
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('C1: an exec re-issued after a restart (here with a different cwd) needs its OWN approval — nothing is carried over', async () => {
    const answers: Array<{ approved: boolean }> = []
    const exec = (cwd: string): ApprovalRequest => ({ tool: 'exec', command: `t5-rm-${process.pid} build`, proposedPattern: 'x', allowlistable: false, args: { command: `t5-rm-${process.pid} build`, cwd } })
    const { runFn } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      answers.push(await ctx.requestApproval!(exec(seg === 0 ? '/tmp/project' : '/')))
      yield { type: 'tool-result', name: 'exec', summary: 'x' }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('c1-exec')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    const a = (await waitForApproval(ws.id)).attention as { requestId: string }
    stopClaiming()
    try { expect(await waitForInFlight(10_000)).toBe(true) } finally { _resumeClaimingForTests() }
    await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    const b = await until(async () => {
      const att = (await getWorkstream(ws.id))?.attention as { kind?: string; requestId?: string } | null
      return att?.kind === 'approval' && att.requestId !== a.requestId ? att : null
    })
    await sleep(200)
    expect(answers).toEqual([{ approved: false }])            // the dead call only — the re-issue is waiting
    expect(pendingBusApprovals()).toContain(b.requestId)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(answers).toEqual([{ approved: false }, { approved: false }])
  })

  it('I1: a worker that dies while parked on a card never counts it as an interruption — four times over', async () => {
    const { ws } = await newWorkstream('park-crash')
    const [q] = await segRuns(ws.conversationId)
    await useDb().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` }).where(eq(agentRuns.id, q!.id))
    for (let i = 0; i < 4; i++) {
      const runId = await killSegment(ws.conversationId)
      await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'approval', text: 'run it?', requestId: `00000000-0000-4000-8000-00000000000${i}`, runId, request: { tool: 'exec', command: 'x', proposedPattern: 'x' } } })
      // The dead segment's iMessage prompt: nothing will ever wait on it again.
      const [prompt] = await useDb().insert(channelApprovals).values({ runId, request: { tool: 'exec' }, chatGuid: 'iMessage;-;+15550000000', expiresAt: new Date(Date.now() + 3_600_000) }).returning()
      await recoverStale({ onlyConversations: [ws.conversationId] })
      expect(await getWorkstream(ws.id)).toMatchObject({ state: 'attention', failures: 0, lastOutcome: 'parked' })
      expect((await useDb().select().from(channelApprovals).where(eq(channelApprovals.id, prompt!.id)))[0]!.status).toBe('expired')
    }
    expect(await activeSegs(ws.conversationId)).toEqual([])
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M9: cancel while parked on a live card denies it, the step ends, cancelled', async () => {
    let answer: { approved: boolean } | undefined
    const { runFn } = harness(async function* (ctx) {
      step(ctx)
      answer = await ctx.requestApproval!(req1())
      for (let i = 0; i < 3 && !ctx.shouldStop?.(); i++) step(ctx)
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('cancel-card')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    await waitForApproval(ws.id)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(answer).toEqual({ approved: false })
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('cancelled')
    expect((row.used as { steps: number }).steps).toBe(1)
    expect(iApprovals[0]!.signal.aborted).toBe(true)
  })

  it('I2: at the cap a new workstream is refused with a clear error; a headless proposal replays into a real start', async () => {
    const open = (await useDb().select({ id: workstreams.id }).from(workstreams).where(inArray(workstreams.state, ['queued', 'running', 'attention']))).length
    const { ws } = await newWorkstream('cap-1')
    const refused = await startWorkstream({ goal: 'T5 cap-2' }, { kick: false, cap: open + 1 }).catch((e: unknown) => e)
    const leaked0 = await useDb().select().from(workstreams).where(eq(workstreams.goal, 'T5 cap-2'))
    convIds.push(...leaked0.map(l => l.conversationId))
    expect(refused).toBeInstanceOf(WorkstreamCapError)
    expect((refused as Error).message).toMatch(/already \d+ workstreams in progress.*T5 cap-1/)
    const leaked = await useDb().select().from(workstreams).where(eq(workstreams.goal, 'T5 cap-2'))
    convIds.push(...leaked.map(l => l.conversationId)) // a regression must not leave rows behind
    expect(leaked).toHaveLength(0)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    // Approving the /review proposal runs the stored call (start_workstream is profile-only).
    const out = await replayAgentAction({ tool: 'start_workstream', args: { goal: 'T5 replayed' } })
    const [made] = await useDb().select().from(workstreams).where(eq(workstreams.goal, 'T5 replayed'))
    if (made) convIds.push(made.conversationId)
    expect(out).toMatchObject({ ok: true })
    expect(made).toBeDefined()
    await controlWorkstream({ workstreamId: made!.id, action: 'cancel' })
  })

  it('I3: an iMessage with exactly ONE workstream waiting on a question is its answer (main gets a note); with two it is not routed', async () => {
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      if (seg === 0) await callTool(ctx, 'ask_tony', { question: 'Which brand?' })
      else await callTool(ctx, 'finish_workstream', { summary: 'ok' })
      yield { type: 'done' }
    })
    const a = await newWorkstream('route-a')
    await drive(a.ws.conversationId)
    expect(texts.join('\n')).toMatch(/Which brand\?[\s\S]*Reply to answer\./)
    const main = await createConversation({ title: 'T5 stand-in main' })
    convIds.push(main.id)
    const r = await routeInboundAnswer({ text: 'Synology', modality: 'text', origin: 'imessage:chat-x' }, { mainConversationId: main.id, onlyConversations: [a.ws.conversationId] })
    expect(r).toMatchObject({ workstreamId: a.ws.id })
    expect((await thread(main.id)).map(m => [m.origin, m.content])).toEqual([[`workstream:${a.ws.id}`, 'answered ⚙ T5 route-a: Synology']])
    await drive(a.ws.conversationId)
    expect(seen[1]!.last).toBe('Synology')
    expect((await thread(a.ws.conversationId)).find(m => m.role === 'user')).toMatchObject({ content: 'Synology', origin: 'imessage:chat-x' })

    // Two waiting: not routed.
    const b = await newWorkstream('route-b')
    const c = await newWorkstream('route-c')
    for (const x of [b, c]) await patchWorkstream(x.ws.id, { state: 'attention', attention: { kind: 'question', text: 'q?' } })
    expect(await routeInboundAnswer({ text: 'hm', modality: 'text' }, { mainConversationId: main.id, onlyConversations: [b.ws.conversationId, c.ws.conversationId] })).toBeNull()
    for (const x of [b, c]) await controlWorkstream({ workstreamId: x.ws.id, action: 'cancel' })
  })

  it('I3: answer_workstream (Bridget) passes the answer on; refused inside a workstream', async () => {
    const { ws } = await newWorkstream('answer-tool')
    const [q] = await segRuns(ws.conversationId)
    await useDb().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` }).where(eq(agentRuns.id, q!.id))
    await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'question', text: 'which?' } })
    const { bridgetProfile } = await import('@mymind/core/lib/agent/profile')
    const tool = bridgetProfile.tools.find(t => t.name === 'answer_workstream')!
    const out = await tool.handler({ id: ws.id, text: 'the blue one' }, { signal: new AbortController().signal })
    expect(out.result).toMatchObject({ ok: true })
    expect((await activeSegs(ws.conversationId)).map(r => (r.input as { text: string }).text)).toEqual(['the blue one'])
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', attention: null })
    // Fix round 2 (I-new-1): only a QUESTION can be answered — never running work, never an approval card.
    expect((await tool.handler({ id: ws.id, text: 'more' }, { signal: new AbortController().signal })).result).toMatchObject({ ok: false, error: /not waiting on a question/ })
    await useDb().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` }).where(eq(agentRuns.conversationId, ws.conversationId))
    await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'approval', text: 'run it?', requestId: '00000000-0000-4000-8000-0000000000bb', runId: q!.id } })
    expect((await tool.handler({ id: ws.id, text: 'deny it' }, { signal: new AbortController().signal })).result).toMatchObject({ ok: false })
    expect(await activeSegs(ws.conversationId)).toEqual([])
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'attention', attention: { kind: 'approval' } })
    expect(tool.outbound).toBe(true)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('fix round 2: resuming a failed/cancelled workstream respects the active cap', async () => {
    const { ws } = await newWorkstream('resume-cap')
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    const open = (await useDb().select({ id: workstreams.id }).from(workstreams).where(inArray(workstreams.state, ['queued', 'running', 'attention']))).length
    const { resumeWorkstream } = await import('@mymind/core/lib/agent/workstreams/loop')
    await expect(resumeWorkstream((await getWorkstream(ws.id))!, undefined, { cap: open })).rejects.toThrow(WorkstreamCapError)
    expect((await getWorkstream(ws.id))!.state).toBe('cancelled')
    await resumeWorkstream((await getWorkstream(ws.id))!, undefined, { cap: open + 1 })
    expect((await getWorkstream(ws.id))!.state).toBe('running')
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M3 + final I3: two idle segments in a row (no tool call, no finish) → PAUSED (told once), not a question', async () => {
    const { seen, drive } = harness(async function* (ctx) {
      step(ctx)
      yield { type: 'text-delta', text: 'I think it is done.' }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('idle')
    await drive(ws.conversationId)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.last).toMatch(/no tool calls in the last segment/)
    const row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('paused')
    expect(row.attention).toMatchObject({ kind: 'paused', text: expect.stringMatching(/made no progress/) })
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/Workstream paused[\s\S]*made no progress/)
    expect(texts[0]).not.toMatch(/Reply to answer/)
    expect(await activeSegs(ws.conversationId)).toEqual([])
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('final I3: Stop in the thread → paused: never captures an iMessage, never nudged, counts toward the cap, Resume continues it', async () => {
    let stepped!: () => void
    const stepping = new Promise<void>(r => { stepped = r })
    const { seen, runFn, drive } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      if (seg === 0) {
        stepped()
        // A long step: it ends only when Tony presses Stop (the run's signal aborts).
        await new Promise<void>(r => ctx.signal.addEventListener('abort', () => r(), { once: true }))
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      await callTool(ctx, 'finish_workstream', { summary: 'resumed and done' })
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('stop')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await stepping
    const [seg0] = await activeSegs(ws.conversationId)
    abortRun(seg0!.id)
    expect(await waitForInFlight(10_000)).toBe(true)
    let row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('paused')
    expect(row.attention).toMatchObject({ kind: 'paused', text: expect.stringMatching(/^Stopped/) })
    expect(row.lastOutcome).toBe('aborted')
    expect(await activeSegs(ws.conversationId)).toEqual([])
    expect(texts).toEqual([])                               // Stop is his own act: nobody is told

    // An unrelated iMessage is NOT captured (it lands in main as an ordinary turn).
    const main = await createConversation({ title: 'T5 stand-in main (stop)' })
    convIds.push(main.id)
    expect(await routeInboundAnswer({ text: "what's on my calendar tomorrow", modality: 'text' }, { mainConversationId: main.id, onlyConversations: [ws.conversationId] })).toBeNull()
    expect(await thread(main.id)).toEqual([])
    expect(await activeSegs(ws.conversationId)).toEqual([])
    // Never nudged — however long it sits.
    await patchWorkstream(ws.id, { attention: { ...(row.attention as object), kind: 'paused', text: 'Stopped.', notifiedAt: 0 } })
    expect(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId] })).toBe(0)
    expect(texts).toEqual([])
    // Still counts toward the cap.
    const open = (await useDb().select({ id: workstreams.id }).from(workstreams).where(inArray(workstreams.state, ['queued', 'running', 'attention', 'paused']))).length
    await expect(startWorkstream({ goal: 'T5 one too many' }, { kick: false, cap: open })).rejects.toThrow(WorkstreamCapError)

    // Resume (the UI's control) continues it.
    const dto = await controlWorkstream({ workstreamId: ws.id, action: 'resume' })
    expect(dto).toMatchObject({ state: 'running', attention: null })
    await drive(ws.conversationId)
    row = (await getWorkstream(ws.id))!
    expect(row.state).toBe('done')
    expect(seen).toHaveLength(2)
    expect((await thread(origin)).some(m => m.origin === `workstream:${ws.id}` && m.content.includes('resumed and done'))).toBe(true)
  })

  it('final I3: answer_workstream resumes a PAUSED workstream with Tony\'s words (resumable via chat)', async () => {
    const { ws } = await newWorkstream('paused-answer')
    await useDb().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` }).where(eq(agentRuns.conversationId, ws.conversationId))
    await patchWorkstream(ws.id, { state: 'paused', attention: { kind: 'paused', text: 'Stopped.' } })
    const { bridgetProfile } = await import('@mymind/core/lib/agent/profile')
    const tool = bridgetProfile.tools.find(t => t.name === 'answer_workstream')!
    expect((await tool.handler({ id: ws.id, text: 'carry on, skip the NAS part' }, { signal: new AbortController().signal })).result).toMatchObject({ ok: true })
    expect((await activeSegs(ws.conversationId)).map(r => (r.input as { text: string }).text)).toEqual(['carry on, skip the NAS part'])
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', attention: null })
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M6: a segment whose finish was fenced off (recovered elsewhere) does not blind the stalled sweep', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let started!: () => void
    const begun = new Promise<void>(r => { started = r })
    const { runFn } = harness(async function* (ctx) {
      step(ctx)
      started()
      await gate
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('fenced')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    await begun
    await useDb().update(agentRuns).set({ status: 'interrupted', finishedAt: sql`now()` }).where(eq(agentRuns.conversationId, ws.conversationId))
    release()
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(await sweepStalledWorkstreams({ onlyConversations: [ws.conversationId], graceMs: 0 })).toBe(1)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M7: words Tony sent to a segment that died while asking become the answer', async () => {
    const { ws } = await newWorkstream('steer-answer')
    const [q] = await segRuns(ws.conversationId)
    const runId = await killSegment(ws.conversationId, q!.id)
    await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'question', text: 'which?' } })
    await useDb().update(agentRuns).set({ aliveAt: sql`now()` }).where(eq(agentRuns.id, runId))
    expect(await pushSteer(runId, ws.conversationId, 'the red one', 'user')).toBe(true)
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, runId))
    await recoverStale({ onlyConversations: [ws.conversationId] })
    expect((await activeSegs(ws.conversationId)).map(r => (r.input as { text: string }).text)).toEqual(['the red one'])
    expect((await useDb().select().from(agentRuns).where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'turn')))).length).toBe(0)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', attention: null })
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M2: an approval attention left over when the segment ends (its card is gone) is cleared and the work continues', async () => {
    const { seen, drive } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      yield { type: 'tool-result', name: 'search_memories', summary: 'x' }
      if (seg === 0) {
        // A late attention write landing after the card was already resolved.
        const ws = await getWorkstream((await useDb().select({ id: workstreams.id }).from(workstreams).where(eq(workstreams.currentRunId, ctx.runId!)))[0]!.id)
        await patchWorkstream(ws!.id, { state: 'attention', attention: { kind: 'approval', text: 'stale', requestId: '00000000-0000-4000-8000-0000000000aa' } })
      } else await callTool(ctx, 'finish_workstream', { summary: 'ok' })
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('stale-attention')
    await drive(ws.conversationId)
    expect(seen).toHaveLength(2)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', attention: null })
  })

  it('M8: a transition that keeps throwing counts toward the 3-failure cap', async () => {
    const { ws } = await newWorkstream('handler-fail')
    const [q] = await segRuns(ws.conversationId)
    for (let i = 0; i < 3; i++) await onSegmentHandlerFailed(q!, new Error('transition broke'))
    const row = (await getWorkstream(ws.id))!
    expect(row).toMatchObject({ state: 'failed', failures: 3 })
    expect(row.failureReason).toMatch(/transition broke/)
  })

  it('M1: a wait on Tony is re-announced at most every 2h through the usual channels', async () => {
    const { ws, origin } = await newWorkstream('nudge')
    await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'question', text: 'which?', notifiedAt: Date.now() - 3 * 60 * 60 * 1000 } })
    expect(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId] })).toBe(0)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/Still waiting on you[\s\S]*which\?/)
    expect((await thread(origin)).filter(m => m.origin === `workstream:${ws.id}`)).toHaveLength(1)
    away = false
    await patchWorkstream(ws.id, { attention: { kind: 'question', text: 'which?', notifiedAt: 0 } })
    expect(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect(texts).toHaveLength(1)                            // present: the app note only
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('final I3: nudges stop after MAX_NUDGES (3) per attention episode; a new question starts a new episode', async () => {
    const { ws } = await newWorkstream('nudge-cap')
    const H = 2 * 60 * 60 * 1000 + 1
    let t = Date.now()
    await patchWorkstream(ws.id, { state: 'attention', attention: { kind: 'question', text: 'which?', notifiedAt: t } })
    const sent: number[] = []
    for (let i = 0; i < 6; i++) { t += H; sent.push(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId], now: t })) }
    expect(sent).toEqual([1, 1, 1, 0, 0, 0])
    expect(texts).toHaveLength(3)
    expect((await getWorkstream(ws.id))!.attention).toMatchObject({ nudges: 3 })
    // A fresh question (ask_tony writes a new attention object) is a new episode.
    await patchWorkstream(ws.id, { attention: { kind: 'question', text: 'and now?', notifiedAt: t } })
    expect(await nudgeWaitingWorkstreams({ onlyConversations: [ws.conversationId], now: t + H })).toBe(1)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })

  it('M1: an approval wait posts a note in the origin chat too', async () => {
    const { runFn } = harness(async function* (ctx) {
      step(ctx)
      await ctx.requestApproval!(req1())
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('approval-note')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })
    await waitForApproval(ws.id)
    await until(async () => (await thread(origin)).some(m => m.origin === `workstream:${ws.id}` && m.content.includes('waiting for your approval')))
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(await waitForInFlight(10_000)).toBe(true)
  })
})

describe('retention', () => {
  it('run_events: finished > 7 days → pruned, except a workstream segment\'s while its workstream exists; claimed-never-handled commands > 1 day pruned', async () => {
    const { ws } = await newWorkstream('retention')
    const chat = await createConversation({ title: 'T5 retention chat' })
    convIds.push(chat.id)
    const db = useDb()
    const mk = async (conversationId: string, kind: 'turn' | 'workstream', agoDays: number) => {
      const [r] = await db.insert(agentRuns).values({
        conversationId, sessionKey: `thread:${conversationId}`, trigger: 'user', profile: 'interactive', kind, input: { text: 'x', modality: 'text' },
        status: 'done', finishedAt: sql`now() - make_interval(days => ${agoDays})`
      }).returning()
      await db.insert(runEvents).values({ ns: NS, runId: r!.id, conversationId, seq: 1, type: 'state', payload: { type: 'state', state: 'idle' } })
      return r!.id
    }
    const oldTurn = await mk(chat.id, 'turn', 8)
    const newTurn = await mk(chat.id, 'turn', 2)
    const oldSeg = await mk(ws.conversationId, 'workstream', 8)
    const ids = [oldTurn, newTurn, oldSeg]
    const left = async () => (await db.select({ runId: runEvents.runId }).from(runEvents).where(inArray(runEvents.runId, ids))).map(r => r.runId).sort()
    expect(await pruneRunEvents(undefined, { onlyRunIds: ids })).toBe(1)
    expect(await left()).toEqual([newTurn, oldSeg].sort())
    await db.delete(workstreams).where(eq(workstreams.id, ws.id))
    expect(await pruneRunEvents(undefined, { onlyRunIds: ids })).toBe(1)
    expect(await left()).toEqual([newTurn])

    const [stuck] = await db.insert(workerCommands).values({ ns: NS, type: 'kick', payload: {}, claimedAt: sql`now() - interval '2 days'` }).returning()
    const [fresh] = await db.insert(workerCommands).values({ ns: NS, type: 'kick', payload: {}, claimedAt: sql`now() - interval '1 hour'` }).returning()
    await pruneHandledCommands()
    const rows = await db.select({ id: workerCommands.id }).from(workerCommands).where(inArray(workerCommands.id, [stuck!.id, fresh!.id]))
    expect(rows.map(r => r.id)).toEqual([fresh!.id])
  })
})

function like_goal(goal: string) { return eq(workstreams.goal, goal) }
