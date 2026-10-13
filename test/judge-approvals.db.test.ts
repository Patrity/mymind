// Cycle 84 Task 2 — the approval judge through the REAL queue → runner → workstream loop → runAgent →
// buildAiTools → workstream approval channel path, with a fake model and a fake (controllable) verdict.
// The rule tier and the audit store are real (approval_verdicts in the shared dev DB). The dev DB is
// shared: this file's own bus namespace, scoped pumps, every row it makes is deleted in afterAll, and
// every outbound notification is captured by workstreamNotifyDeps.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, approvalVerdicts, conversationMessages, conversations, runEvents, workerCommands, workspaces, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { _resumeClaimingForTests, pumpOnce, setExecutionMode, stopClaiming, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { approvalSurface, runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { busApprovalChannel, decideBusApproval, pendingBusApprovals } from '@mymind/core/lib/agent/runtime/bus-approvals'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { openApprovalFrames } from '@mymind/core/lib/bus/events'
import { closeListener } from '@mymind/core/lib/bus/listen'
import { createConversation } from '@mymind/core/services/conversations'
import { controlWorkstream, restoreParkedApprovals, startWorkstream } from '@mymind/core/lib/agent/workstreams/loop'
import { getWorkstream, patchAttentionJudge, toWorkstreamDTO } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import { runAgent, type AgentMessage, type RunAgentCtx } from '@mymind/core/lib/agent/run'
import { approvalJudgeDeps, createApprovalJudge, defaultApprovalJudgeDeps } from '@mymind/core/lib/agent/judge/approval'
import type { AgentTool, ApprovalRequest } from '@mymind/core/lib/agent/types'
import type { ApprovalVerdictDTO, JudgeVerdict } from '@mymind/core/lib/agent/judge/types'
import type { WorkstreamAttention } from '@mymind/core/shared/types/workstreams'
import { stubOutcomeVerifier } from './helpers/outcome-stub'
stubOutcomeVerifier() // cycle 85: finishes here are not about the outcome judge

const NS = `judge-t2-${process.pid}`
const convIds: string[] = []
const nonces: string[] = []
const realNotify = { ...workstreamNotifyDeps }
const iApprovals: Array<{ req: ApprovalRequest; verdict?: () => ApprovalVerdictDTO | null }> = []
const texts: string[] = []
const ran: string[] = []
const APPROVE: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 0.96, reasons: ['matches the goal'], model: 'J', latencyMs: 4 }
let release: (v: JudgeVerdict) => void = () => {}
/** Each verdict request in order (parallel calls get their own). */
let verdicts: Array<{ resolve: (v: JudgeVerdict) => void }> = []

beforeAll(() => { setBusNs(NS); setExecutionMode('remote') })
beforeEach(() => {
  iApprovals.length = 0
  texts.length = 0
  ran.length = 0
  workstreamNotifyDeps.isAway = async () => true
  workstreamNotifyDeps.text = async (t) => { texts.push(t); return [] }
  workstreamNotifyDeps.imessageApproval = (_runId, req, signal, verdict) => {
    iApprovals.push({ req, verdict })
    return new Promise(res => signal.addEventListener('abort', () => res({ approved: false }), { once: true }))
  }
  // Settings + verdict are faked (no agent_settings write to the shared DB, no model call); the
  // rule tier and the audit store are the real ones.
  // `release` answers every verdict asked so far and every later one; `verdicts[i]` answers one.
  verdicts = []
  let released: JudgeVerdict | null = null
  release = (v) => { released = v; for (const d of verdicts) d.resolve(v) }
  const settings = async () => ({ enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 })
  Object.assign(approvalJudgeDeps, {
    settings, freshSettings: settings,
    verdict: () => new Promise<JudgeVerdict>((resolve) => { verdicts.push({ resolve }); if (released) resolve(released) }),
    ruleContextWaitMs: 50
  })
})
afterEach(() => { Object.assign(approvalJudgeDeps, defaultApprovalJudgeDeps) })
afterAll(async () => {
  Object.assign(workstreamNotifyDeps, realNotify)
  const db = useDb()
  const runIds = convIds.length ? (await db.select({ id: agentRuns.id }).from(agentRuns).where(inArray(agentRuns.conversationId, convIds))).map(r => r.id) : []
  if (runIds.length) await db.delete(approvalVerdicts).where(inArray(approvalVerdicts.runId, runIds))
  if (nonces.length) await db.delete(approvalVerdicts).where(inArray(approvalVerdicts.nonce, nonces))
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
  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(approvalVerdicts).where(inArray(approvalVerdicts.runId, runIds.length ? runIds : ['00000000-0000-4000-8000-000000000000']))
  expect(left!.n).toBe(0)
  setExecutionMode('local')
  setBusNs(null)
  await closeListener()
})

// ── harness ─────────────────────────────────────────────────────────────────────────────────

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
const finish = (r: 'tool-calls' | 'stop') => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A dangerous tool the REAL rule tier floors per its args: `review` (an RSVP) or `high` (a cancel). */
const guestEvent: AgentTool = {
  name: 'calendar_guest_event', description: 'Create, update or cancel an event with guests', kind: 'create', toolset: 'calendar', dangerous: true,
  schema: { op: z.string(), eventId: z.string() },
  describeApproval: a => ({ tool: 'calendar_guest_event', title: 'Change this event?', command: `${String(a.op)} ${String(a.eventId)}`, proposedPattern: '' }),
  handler: async (a) => { ran.push(`${String(a.op)}:${String(a.eventId)}`); return { result: { ok: true }, summary: 'event changed' } }
}

function runFn(op: string, parallel = false) {
  return (r: AgentRun) => runTurn(r, {
    assemble: (async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })) as never,
    unavailableToolsets: async () => [],
    runAgent: ((messages: AgentMessage[], ctx: RunAgentCtx) => {
      const steps = [
        // Some text with the call, so the turn persists an assistant row carrying the tool record.
        [...text('changing the event'), call('c1', 'calendar_guest_event', { op, eventId: 'standup' }),
          ...(parallel ? [call('c1b', 'calendar_guest_event', { op, eventId: 'retro' })] : []), finish('tool-calls')],
        [call('c2', 'finish_workstream', { summary: 'done with the event' }), finish('tool-calls')],
        [...text('done'), finish('stop')]
      ]
      let i = 0
      const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream(steps[Math.min(i++, steps.length - 1)]! as never) }) })
      const tools = [guestEvent, ...(ctx.profile?.tools ?? []).filter(t => t.name === 'finish_workstream')]
      return runAgent(messages, ctx, { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools, buildSystemPrompt: async () => 's' })
    }) as never
  })
}

async function newWorkstream(goal: string) {
  const origin = await createConversation({ title: `judge-t2 origin ${goal}` })
  convIds.push(origin.id)
  const ws = await startWorkstream({ goal: `judge-t2 ${goal}`, originConversationId: origin.id }, { kick: false })
  convIds.push(ws.conversationId)
  return { ws, origin: origin.id }
}
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(20)
  }
}
const segRun = async (convId: string) => (await useDb().select().from(agentRuns).where(and(eq(agentRuns.conversationId, convId), eq(agentRuns.kind, 'workstream'))).orderBy(asc(agentRuns.createdAt)))[0]
const verdictRows = (runId: string) => useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.runId, runId))
const framesOf = async (convId: string) => (await useDb().select({ type: runEvents.type, payload: runEvents.payload }).from(runEvents)
  .where(and(eq(runEvents.ns, NS), eq(runEvents.conversationId, convId))).orderBy(asc(runEvents.id)))
  .filter(r => r.type.startsWith('approval')).map(r => r.payload as Record<string, unknown>)

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe('approval judge in a workstream (real runner + loop)', () => {
  it('Smart Approvals: evaluating (no attention, no texts) → the judge approves → the call EXECUTES; audit decided_by judge; the record carries the ⚖ note', async () => {
    const { ws, origin } = await newWorkstream('auto')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp') })).toBe(1)
    // While the judge thinks: still running, no attention — only the `evaluating` detail.
    const evaluating = await until(async () => { const r = await getWorkstream(ws.id); return r?.stateDetail === 'evaluating' ? r : null })
    expect(toWorkstreamDTO(evaluating)).toMatchObject({ state: 'running', attention: null, stateDetail: 'evaluating' })
    const run = (await segRun(ws.conversationId))!
    const [pendingRow] = await verdictRows(run.id)
    expect(pendingRow).toMatchObject({ tool: 'calendar_guest_event', ruleFloor: 'review', workstreamId: ws.id, decision: null, recommendation: null })
    release(APPROVE)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual(['rsvp:standup'])
    const [row] = await verdictRows(run.id)
    expect(row).toMatchObject({ decision: 'auto', decidedBy: 'judge', risk: 'low', recommendation: 'approve', confidence: expect.closeTo(0.96, 5), reasons: ['matches the goal'], ruleFloor: 'review' })
    expect(row!.decidedAt).not.toBeNull()
    // The card streamed its verdict and was resolved by the judge — on the thread and in the origin chat.
    for (const conv of [ws.conversationId, origin]) {
      const frames = await framesOf(conv)
      expect(frames.map(f => f.type)).toEqual(expect.arrayContaining(['approval', 'approval-verdict', 'approval-resolved']))
      expect(frames.find(f => f.type === 'approval-resolved')).toMatchObject({ decidedBy: 'judge', auto: { decidedBy: 'judge', confidence: 0.96, reason: 'matches the goal' } })
    }
    // Never waited on Tony: no attention ever, no iMessage prompt.
    expect(iApprovals).toEqual([])
    const done = (await getWorkstream(ws.id))!
    expect(done.state).toBe('done')
    expect(done.stateDetail).toBeNull()
    // The thread's "⚖ auto-approved (0.96): …" note rides on the call's persisted tool record.
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, ws.conversationId))
    const rec = msgs.flatMap(m => (m.toolCalls as Array<{ name: string; approval?: unknown }> | null) ?? []).find(t => t.name === 'calendar_guest_event')
    expect(rec?.approval).toEqual({ decidedBy: 'judge', confidence: 0.96, reason: 'matches the goal' })
  })

  it('a rule-high call (cancel with guests): attention at once with the judge state, the verdict patched in when it lands; never auto; Tony decides', async () => {
    const { ws } = await newWorkstream('high')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('cancel') })).toBe(1)
    const row = await until(async () => { const r = await getWorkstream(ws.id); return (r?.attention as WorkstreamAttention | null)?.kind === 'approval' ? r : null })
    const att = row.attention as WorkstreamAttention
    expect(row.state).toBe('attention')
    expect(att.judge).toMatchObject({ rule: { floor: 'high' }, verdict: null, pending: true, autoPossible: false })
    await until(async () => iApprovals.length > 0)
    expect(iApprovals[0]!.verdict?.()).toMatchObject({ rule: { floor: 'high' } })
    release({ ...APPROVE, confidence: 1 })
    const patched = await until(async () => { const r = await getWorkstream(ws.id); const j = (r?.attention as WorkstreamAttention | null)?.judge; return j?.verdict ? j : null })
    expect(patched).toMatchObject({ verdict: { recommendation: 'approve', confidence: 1 }, pending: false, autoPossible: false })
    // A socket that (re)attaches gets the open card AND its latest verdict (ws.ts re-sends both).
    const open = await until(async () => { const o = await openApprovalFrames(ws.conversationId); return o[0]?.verdict?.judge.verdict ? o : null })
    expect(open).toHaveLength(1)
    expect(open[0]!.frame.requestId).toBe(att.requestId)
    expect(open[0]!.verdict).toMatchObject({ type: 'approval-verdict', requestId: att.requestId, judge: { verdict: { recommendation: 'approve' } } })
    await sleep(50)
    expect(ran).toEqual([])                                     // the approve verdict did not run it
    expect(pendingBusApprovals()).toContain(att.requestId)
    // Only THIS card's attention takes a verdict: another request id patches nothing.
    expect(await patchAttentionJudge(ws.id, '00000000-0000-4000-8000-0000000000ff', { rule: null, verdict: null, pending: true, autoPossible: false })).toBe(false)
    expect((((await getWorkstream(ws.id))!.attention) as WorkstreamAttention).judge).toMatchObject({ verdict: { recommendation: 'approve' } })
    expect(decideBusApproval({ requestId: att.requestId!, approved: true })).toBe(true)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual(['cancel:standup'])
    const run = (await segRun(ws.conversationId))!
    await until(async () => (await verdictRows(run.id))[0]?.decision ? true : null)
    expect((await verdictRows(run.id))[0]).toMatchObject({ ruleFloor: 'high', decision: 'approved', decidedBy: 'tony', recommendation: 'approve' })
  })
})

describe('parked Task 2 item: two cards waiting at once', () => {
  it('the attention names both; deciding one leaves the other; a drain parks both and the restore note names both', async () => {
    const { ws } = await newWorkstream('two-cards')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('cancel', true) })   // rule high: both need Tony
    const both = await until(async () => {
      const a = (await getWorkstream(ws.id))?.attention as WorkstreamAttention | null
      return a?.kind === 'approval' && a.alsoParked?.length === 1 ? a : null
    })
    expect([both.request!.command, both.alsoParked![0]!.command].sort()).toEqual(['cancel retro', 'cancel standup'])
    // Tony denies the primary card: the attention now shows the other one alone.
    expect(decideBusApproval({ requestId: both.requestId!, approved: false })).toBe(true)
    const left = await until(async () => {
      const a = (await getWorkstream(ws.id))?.attention as WorkstreamAttention | null
      return a?.kind === 'approval' && a.requestId !== both.requestId ? a : null
    })
    expect(left.alsoParked).toBeUndefined()
    expect(left.request!.command).toBe(both.alsoParked![0]!.command)
    // Deny it too; the segment goes on.
    expect(decideBusApproval({ requestId: left.requestId!, approved: false })).toBe(true)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual([])
  })

  it('a drain with two cards waiting: the restore note names both actions', async () => {
    const { ws } = await newWorkstream('two-cards-drain')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('cancel', true) })
    await until(async () => ((await getWorkstream(ws.id))?.attention as WorkstreamAttention | null)?.alsoParked?.length === 1)
    stopClaiming()
    try { expect(await waitForInFlight(10_000)).toBe(true) } finally { _resumeClaimingForTests() }
    expect(await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })).toBe(1)
    const queued = (await useDb().select().from(agentRuns).where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.status, 'queued'))))[0]!
    const note = (queued.input as { text: string }).text
    expect(note).toContain('cancel standup')
    expect(note).toContain('cancel retro')
    expect(ran).toEqual([])
  })
})

describe('final fix wave M3: judge time is not wall time', () => {
  it('a segment that waited ~1.5 s on the verdict records far less wall time than that', async () => {
    const { ws } = await newWorkstream('m3-wall')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp') })).toBe(1)
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'evaluating')
    await sleep(1500)
    release(APPROVE)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual(['rsvp:standup'])
    const used = (await getWorkstream(ws.id))!.used as { wallMs: number }
    expect(used.wallMs).toBeLessThan(1000)
  })
})

describe('approval judge on a chat card (real store)', () => {
  const tool = { name: 'calendar_rsvp', description: 'RSVP' }
  it('the verdict is persisted; chat stays manual; a late verdict after Tony\'s decision is recorded and changes nothing', async () => {
    const nonce = `judge-t2-${process.pid}-chat`
    nonces.push(nonce)
    const frames: Array<Record<string, unknown>> = []
    const judge = createApprovalJudge({ tool, input: { eventId: 'e1', response: 'accepted' }, req: { title: 'Send RSVP?', command: 'RSVP accepted' }, nonce, surface: 'chat', isTainted: () => false })
    const ch = busApprovalChannel('00000000-0000-4000-8000-0000000000c4', { publish: f => frames.push(f as never), timeoutMs: null })
    const p = ch({ tool: tool.name, command: 'RSVP accepted', proposedPattern: '' }, { judge })
    const requestId = frames[0]!.requestId as string
    await until(async () => (await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, nonce)))[0])
    expect(decideBusApproval({ requestId, approved: false })).toBe(true)
    expect(await p).toEqual({ approved: false })
    release(APPROVE)
    await until(async () => frames.length && (await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, nonce)))[0]?.recommendation ? true : null)
    await judge.writes()
    const [row] = await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, nonce))
    expect(row).toMatchObject({ tool: 'calendar_rsvp', ruleFloor: 'review', decision: 'denied', decidedBy: 'tony', recommendation: 'approve', risk: 'low' })
    expect(frames.filter(f => f.type === 'approval-resolved')).toEqual([{ type: 'approval-resolved', requestId, decidedBy: 'tony' }])
  })
})

describe('approvalSurface (runner)', () => {
  it('a segment is a workstream; a job or a wake is headless (never auto); anything else interactive is chat', () => {
    expect(approvalSurface({ profile: 'interactive', trigger: 'user' }, true)).toBe('workstream')
    expect(approvalSurface({ profile: 'headless', trigger: 'job' }, false)).toBe('headless')
    expect(approvalSurface({ profile: 'interactive', trigger: 'wake' }, false)).toBe('headless')
    expect(approvalSurface({ profile: 'interactive', trigger: 'user' }, false)).toBe('chat')
  })
})

describe('fix round 1 (C2, C3, M2)', () => {
  it('C2: a drain while the judge is still deciding parks the request; the next worker withdraws it and resumes (nothing ran)', async () => {
    const { ws, origin } = await newWorkstream('drain-eval')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp') })
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'evaluating')
    stopClaiming()                                              // the worker's SIGTERM drain
    try { expect(await waitForInFlight(10_000)).toBe(true) } finally { _resumeClaimingForTests() }
    const parked = (await getWorkstream(ws.id))!
    expect(parked).toMatchObject({ state: 'attention', lastOutcome: 'parked', stateDetail: null })
    expect(parked.attention).toMatchObject({ kind: 'approval', request: { tool: 'calendar_guest_event' } })
    expect(iApprovals).toEqual([])                              // nobody was asked: it was parked, not waiting
    expect(await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', attention: null })
    expect(await openApprovalFrames(origin)).toEqual([])
    release(APPROVE)                                            // a verdict for the dead call changes nothing
    await sleep(50)
    expect(ran).toEqual([])
    const run = (await segRun(ws.conversationId))!
    await until(async () => (await verdictRows(run.id))[0]?.decision ? true : null)
    expect((await verdictRows(run.id))[0]).toMatchObject({ decision: 'cancelled', decidedBy: 'system' })
  })

  it('C3: a workstream cancel during evaluation withdraws the request (cancelled / system); a later verdict changes nothing', async () => {
    const { ws } = await newWorkstream('cancel-eval')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp') })
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'evaluating')
    const run = (await segRun(ws.conversationId))!
    expect(pendingBusApprovals(run.id)).toHaveLength(1)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(pendingBusApprovals(run.id)).toEqual([])             // the cancel resolved the request at once
    release(APPROVE)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual([])
    expect((await getWorkstream(ws.id))!.state).toBe('cancelled')
    await until(async () => (await verdictRows(run.id))[0]?.recommendation ? true : null)
    expect((await verdictRows(run.id))[0]).toMatchObject({ decision: 'cancelled', decidedBy: 'system', recommendation: 'approve' })
    const resolved = (await framesOf(ws.conversationId)).filter(f => f.type === 'approval-resolved')
    expect(resolved).toEqual([expect.objectContaining({ decidedBy: 'system' })])
  })

  it('M2: two calls judged at once — `evaluating` lasts until the LAST one is decided', async () => {
    const { ws } = await newWorkstream('two-evals')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp', true) })
    await until(async () => verdicts.length === 2)
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'evaluating')
    verdicts[0]!.resolve(APPROVE)
    await until(async () => ran.length === 1)
    await sleep(100)
    expect((await getWorkstream(ws.id))!.stateDetail).toBe('evaluating')   // the second is still being judged
    verdicts[1]!.resolve(APPROVE)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran.sort()).toEqual(['rsvp:retro', 'rsvp:standup'])
    expect((await getWorkstream(ws.id))!.stateDetail).toBeNull()
  })
})

describe('fix round 2', () => {
  it('a drain parks EVERY call still being judged; the approval-lost note names them all', async () => {
    const { ws } = await newWorkstream('drain-two')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('rsvp', true) })
    await until(async () => verdicts.length === 2)
    stopClaiming()
    try { expect(await waitForInFlight(10_000)).toBe(true) } finally { _resumeClaimingForTests() }
    const att = (await getWorkstream(ws.id))!.attention as WorkstreamAttention
    const parked = [att.request, ...(att.alsoParked ?? [])].map(r => r!.command).sort()
    expect(parked).toEqual(['rsvp retro', 'rsvp standup'])
    expect(await restoreParkedApprovals({ onlyConversations: [ws.conversationId] })).toBe(1)
    const queued = (await useDb().select().from(agentRuns).where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.status, 'queued'))))[0]!
    const note = (queued.input as { text: string }).text
    expect(note).toContain('rsvp standup')
    expect(note).toContain('rsvp retro')
    expect(note).toContain('None of those actions ran')
    expect(ran).toEqual([])
  })

  it.each([
    ['expired unanswered (30 days)', { approved: false, decidedBy: 'timeout' as const }, 'cancelled', 'system'],
    ['Tony\'s 👎 on the phone', { approved: false, decidedBy: 'tony' as const }, 'denied', 'tony']
  ])('the mirrored away prompt: %s → the card ends %s / %s', async (_label, answer, decision, by) => {
    workstreamNotifyDeps.imessageApproval = async () => answer
    const { ws } = await newWorkstream(`mirror-${by}`)
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('cancel') })   // rule high: Tony asked at once
    release({ ...APPROVE, recommendation: 'review' })
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual([])
    const run = (await segRun(ws.conversationId))!
    await until(async () => (await verdictRows(run.id))[0]?.decision ? true : null)
    expect((await verdictRows(run.id))[0]).toMatchObject({ decision, decidedBy: by })
  })

  it('a mirrored prompt that could not be sent leaves the card OPEN — a later approve in the app executes the call', async () => {
    workstreamNotifyDeps.imessageApproval = async () => ({ approved: false, decidedBy: 'system' })   // send failed
    const { ws } = await newWorkstream('mirror-send-failed')
    await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn('cancel') })   // rule high: Tony asked at once
    const row = await until(async () => { const r = await getWorkstream(ws.id); return (r?.attention as WorkstreamAttention | null)?.kind === 'approval' ? r : null })
    const requestId = (row.attention as WorkstreamAttention).requestId!
    release({ ...APPROVE, recommendation: 'review' })
    await sleep(150)                                            // the failed prompt has come back
    expect(pendingBusApprovals()).toContain(requestId)           // still waiting on the web card
    expect((await getWorkstream(ws.id))!.state).toBe('attention')
    expect(ran).toEqual([])
    const run = (await segRun(ws.conversationId))!
    expect((await verdictRows(run.id))[0]?.decision).toBeNull()
    expect(decideBusApproval({ requestId, approved: true })).toBe(true)
    expect(await waitForInFlight(15_000)).toBe(true)
    expect(ran).toEqual(['cancel:standup'])
    await until(async () => (await verdictRows(run.id))[0]?.decision ? true : null)
    expect((await verdictRows(run.id))[0]).toMatchObject({ decision: 'approved', decidedBy: 'tony' })
  })
})
