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

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, conversationMessages, conversations, runEvents, workerCommands, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { _resumeClaimingForTests, enqueue, pumpOnce, setExecutionMode, stopClaiming, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { recoverStale } from '@mymind/core/lib/agent/runtime/recover'
import { decideBusApproval, pendingBusApprovals } from '@mymind/core/lib/agent/runtime/bus-approvals'
import { openApprovalFrames, pruneRunEvents } from '@mymind/core/lib/bus/events'
import { pruneHandledCommands } from '@mymind/core/lib/bus/commands'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import { createConversation, appendMessages } from '@mymind/core/services/conversations'
import { controlWorkstream, startWorkstream, sweepStalledWorkstreams } from '@mymind/core/lib/agent/workstreams/loop'
import { getWorkstream, patchWorkstream } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import { startWorkstreamTool } from '@mymind/core/lib/agent/tools/workstreams'
import { subscribeChanges } from '@mymind/core/utils/live-bus'
import type { RunAgentCtx, AgentMessage, AgentEvent } from '@mymind/core/lib/agent/run'
import type { ApprovalRequest } from '@mymind/core/lib/agent/types'
import type { LiveEvent } from '@mymind/core/shared/types/live'

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
  const ws = await startWorkstream({ goal: `T5 ${goal}`, originConversationId: origin.id, budget }, { kick: false })
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
        for (let i = 0; i < 3 && !ctx.shouldStop?.(); i++) step(ctx)
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
    expect(row.attention).toEqual({ kind: 'question', text: 'Synology or QNAP?' })
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
