// Cycle 85 Task 1 — the outcome judge on finish_workstream (spec §2), through the REAL queue → runner →
// loop path (as workstreams.db.test.ts): segments are real agent_runs rows run by runTurn with a fake
// model that calls the real finish_workstream tool. The VERIFIER is the seam: `outcomeDeps.verify` is
// a scripted fake (or the real verifyOutcome over a fake model call), and the evidence builder runs
// for real against this file's run_events / workstream rows with a fake workspace diff. The dev DB is
// shared: everything is scoped to this file's conversations and bus namespace, and cleaned up.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest'
import { vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { activityLog, agentInbox, agentRuns, conversationMessages, conversations, runEvents, workerCommands, workspaces, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { pumpOnce, setExecutionMode, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { runTurn } from '@mymind/core/lib/agent/runtime/runner'
import { recoverStale } from '@mymind/core/lib/agent/runtime/recover'
import { abortRun } from '@mymind/core/lib/agent/runtime/aborts'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import { createConversation } from '@mymind/core/services/conversations'
import { controlWorkstream, startWorkstream } from '@mymind/core/lib/agent/workstreams/loop'
import { getWorkstream, patchWorkstream, workstreamDTO } from '@mymind/core/lib/agent/workstreams/store'
import { workstreamNotifyDeps } from '@mymind/core/lib/agent/workstreams/notify'
import {
  buildOutcomeEvidence, buildWorkstreamEvidence, outcomeDeps, verifyOutcome,
  type OutcomeEvidence, type OutcomeVerdict, type WorkspaceDiffDeps
} from '@mymind/core/lib/agent/judge/outcome'
import { recorder } from '@mymind/core/lib/observability/record'
import type { RunAgentCtx, AgentMessage, AgentEvent } from '@mymind/core/lib/agent/run'
import type { ResolvedModel } from '@mymind/core/lib/ai/registry/types'

const NS = `t85-oj-${process.pid}`
const convIds: string[] = []
const wsIds: string[] = []
const realNotify = { ...workstreamNotifyDeps }
const realOutcome = { ...outcomeDeps }
const texts: string[] = []
/** Every evidence the verifier was given, in order. */
const judged: OutcomeEvidence[] = []
/** The scripted verdicts, consumed one per verification (the last one repeats). */
let script: Array<OutcomeVerdict | (() => Promise<OutcomeVerdict>)> = []
let verifyCalls = 0

const V = (o: Partial<OutcomeVerdict> = {}): OutcomeVerdict => ({ verdict: 'met', confidence: 0.9, gaps: [], nextStep: null, model: 'fake-verifier', latencyMs: 3, ...o })
const PARTIAL = V({ verdict: 'partial', confidence: 0.8, gaps: ['no prices for the third box'], nextStep: 'look up the TS-464 price' })
const noDiff: WorkspaceDiffDeps = { exec: async () => ({ exitCode: 0, stdout: '## git diff --stat\n notes.md | 4 ++++', stderr: '' }), secrets: async () => [] }

beforeAll(() => { setBusNs(NS); setExecutionMode('remote') })
beforeEach(() => {
  texts.length = 0
  judged.length = 0
  verifyCalls = 0
  script = [V()]
  workstreamNotifyDeps.isAway = async () => true
  workstreamNotifyDeps.text = async (t) => { texts.push(t); return [] }
  // Real evidence (this file's run_events + rows), a fake workspace diff; a scripted verifier.
  outcomeDeps.evidence = (ws, summary, o) => buildWorkstreamEvidence(ws, summary, { ...o, diff: noDiff })
  outcomeDeps.enabled = async () => true
  outcomeDeps.verify = async (e) => {
    judged.push(e)
    const next = script[Math.min(verifyCalls++, script.length - 1)]!
    return typeof next === 'function' ? next() : next
  }
})
afterAll(async () => {
  Object.assign(workstreamNotifyDeps, realNotify)
  Object.assign(outcomeDeps, realOutcome)
  await recorder.flush().catch(() => {})
  const db = useDb()
  if (wsIds.length) await db.delete(activityLog).where(and(eq(activityLog.name, 'judge:outcome'), sql`${activityLog.meta}->>'workstreamId' in (${sql.join(wsIds.map(i => sql`${i}`), sql`, `)})`))
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

// ── harness (as workstreams.db.test.ts) ───────────────────────────────────────────────────────

type Script = (ctx: RunAgentCtx, messages: AgentMessage[], seg: number) => AsyncGenerator<AgentEvent>
const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function step(ctx: RunAgentCtx): void { ctx.onStep?.({ inputTokens: 10, outputTokens: 5 }) }
async function finish(ctx: RunAgentCtx, summary: string): Promise<{ result: Record<string, unknown>; summary: string }> {
  const t = ctx.profile!.tools.find(x => x.name === 'finish_workstream')!
  return (await t.handler({ summary }, { signal: ctx.signal, runId: ctx.runId })) as { result: Record<string, unknown>; summary: string }
}
function harness(s: Script) {
  let n = 0
  const runFn = (r: AgentRun) => runTurn(r, { runAgent: ((m: AgentMessage[], ctx: RunAgentCtx) => s(ctx, m, n++)) as never, assemble: noAssemble as never, unavailableToolsets: async () => [] })
  const drive = async (convId: string, rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      if (!await pumpOnce({ onlyConversations: [convId], rekick: false, run: runFn })) return
      expect(await waitForInFlight(20_000)).toBe(true)
    }
  }
  return { runFn, drive, segments: () => n }
}
async function newWorkstream(goal: string, o: { toolsets?: string[] } = {}) {
  const origin = await createConversation({ title: `T85 origin ${goal}` })
  convIds.push(origin.id)
  const ws = await startWorkstream({ goal: `T85 ${goal}`, originConversationId: origin.id, toolsets: o.toolsets }, { kick: false })
  convIds.push(ws.conversationId)
  wsIds.push(ws.id)
  return { ws, origin: origin.id }
}
const thread = (convId: string) => useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, convId)).orderBy(asc(conversationMessages.createdAt))
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(20)
  }
}
async function outcomeEvents(id: string) {
  await recorder.flush()
  return useDb().select().from(activityLog).where(and(eq(activityLog.name, 'judge:outcome'), sql`${activityLog.meta}->>'workstreamId' = ${id}`)).orderBy(asc(activityLog.createdAt))
}
/** A gate a fake verifier waits on. */
function gate() {
  let open!: () => void
  const p = new Promise<void>(r => { open = r })
  return { p, open }
}

// ── the state machine ───────────────────────────────────────────────────────────────────────────

describe('outcome judge — finish_workstream', () => {
  it('met → done: the verdict is stored and shown, Tony gets no ⚠, activity judge:outcome', async () => {
    let out: Awaited<ReturnType<typeof finish>> | undefined
    const { drive } = harness(async function* (ctx) {
      step(ctx)
      out = await finish(ctx, 'SUMMARY-MET: compared all three')
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('met')
    await drive(ws.conversationId)
    const row = (await getWorkstream(ws.id))!
    expect(row).toMatchObject({ state: 'done', summary: 'SUMMARY-MET: compared all three', sendBacks: 0, stateDetail: null })
    expect(row.verification).toMatchObject({ verdict: 'met', confidence: 0.9, outcome: 'finished', sendBacks: 0, model: 'fake-verifier', at: expect.any(String) })
    expect(out).toMatchObject({ result: { ok: true, state: 'done' }, summary: 'workstream finished' })
    expect(judged).toHaveLength(1)
    expect(judged[0]).toMatchObject({ goal: 'T85 met', summary: 'SUMMARY-MET: compared all three', workspace: expect.stringContaining('notes.md') })
    expect(judged[0]!.children).toBeUndefined()           // not a coordinator
    const note = (await thread(origin)).find(m => m.origin === `workstream:${ws.id}`)!
    expect(note.content).toContain('SUMMARY-MET')
    expect(note.content).not.toContain('⚠')
    expect((await workstreamDTO(row))).toMatchObject({ verification: { verdict: 'met' }, sendBacks: 0 })
    expect(await outcomeEvents(ws.id)).toMatchObject([{ severity: 'info', meta: { outcome: 'finished', verdict: 'met', sendBacks: 0 } }])
  })

  it('partial → sent back twice across segments ("Not done yet", the work continues) → the third finish ends DONE, flagged', async () => {
    script = [PARTIAL]
    const results: Array<Awaited<ReturnType<typeof finish>>> = []
    const { drive, segments } = harness(async function* (ctx) {
      step(ctx)
      results.push(await finish(ctx, `SUMMARY-${results.length + 1}`))
      yield { type: 'tool-result', name: 'finish_workstream', summary: results.at(-1)!.summary }
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('partial')
    await drive(ws.conversationId)
    expect(segments()).toBe(3)
    expect(results.map(r => r.result.notDone ?? false)).toEqual([true, true, false])
    expect(results[0]!.result.error).toEqual(expect.stringMatching(/^Not done yet: no prices for the third box; next: look up the TS-464 price\. \(Outcome check 1 of 2/))
    expect(results[1]!.result.error).toEqual(expect.stringMatching(/Outcome check 2 of 2/))
    expect(results[0]!.summary).toBe('⚖ verifier sent this back (1/2): no prices for the third box')
    expect(results[2]).toMatchObject({ result: { ok: true, state: 'done', verifier: 'partial' }, summary: 'workstream finished — ⚠ verifier: partial — no prices for the third box' })
    const row = (await getWorkstream(ws.id))!
    expect(row).toMatchObject({ state: 'done', summary: 'SUMMARY-3', sendBacks: 2 })
    expect(row.verification).toMatchObject({ verdict: 'partial', outcome: 'flagged', sendBacks: 2, gaps: ['no prices for the third box'] })
    // Never failed by the verifier; Tony is told with the flag.
    const note = (await thread(origin)).find(m => m.origin === `workstream:${ws.id}`)!
    expect(note.content).toContain('⚠ verifier: partial — no prices for the third box')
    expect(texts.join('\n')).toContain('⚠ verifier: partial')
    expect((await outcomeEvents(ws.id)).map(e => (e.meta as { outcome: string }).outcome)).toEqual(['sent-back', 'sent-back', 'flagged'])
  })

  it('the send-back counter lives on the row: a workstream already sent back twice (an earlier worker life) finishes flagged at once', async () => {
    script = [V({ verdict: 'unmet', confidence: 0.95, gaps: ['nothing was compared'] })]
    const { drive } = harness(async function* (ctx) { step(ctx); await finish(ctx, 'claimed'); yield { type: 'done' } })
    const { ws } = await newWorkstream('counter')
    await useDb().update(workstreams).set({ sendBacks: 2 }).where(eq(workstreams.id, ws.id))
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', sendBacks: 2, verification: { verdict: 'unmet', outcome: 'flagged' } })
    expect(verifyCalls).toBe(1)
  })

  it('a verifier error → done at once, flagged with the error (never blocks, never failed)', async () => {
    script = [V({ verdict: null, confidence: 0, error: 'verifier failed: 502' })]
    const { drive } = harness(async function* (ctx) { step(ctx); await finish(ctx, 'ok'); yield { type: 'done' } })
    const { ws, origin } = await newWorkstream('error')
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', sendBacks: 0, verification: { verdict: null, error: 'verifier failed: 502', outcome: 'flagged' } })
    expect((await thread(origin)).find(m => m.origin === `workstream:${ws.id}`)!.content).toContain('⚠ verifier: could not check it (verifier failed: 502)')
    expect(await outcomeEvents(ws.id)).toMatchObject([{ severity: 'warn', meta: { outcome: 'flagged', error: 'verifier failed: 502' } }])
  })

  it('a verifier timeout (the REAL verifyOutcome, a model that never answers) → done, flagged "timed out"', async () => {
    const hang = async () => new Promise<never>(() => {})
    outcomeDeps.verify = (e, o) => verifyOutcome(e, { ...o, chain: async () => [{ label: 'fake' } as unknown as ResolvedModel], call: hang, timeoutMs: 150 })
    const { drive } = harness(async function* (ctx) { step(ctx); await finish(ctx, 'ok'); yield { type: 'done' } })
    const { ws } = await newWorkstream('timeout')
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', verification: { verdict: null, error: 'verifier timed out', outcome: 'flagged' } })
  })

  it('judge switched off → no verdict at all: done, recorded `skipped` (no ⚠)', async () => {
    outcomeDeps.enabled = async () => false
    const { drive } = harness(async function* (ctx) { step(ctx); await finish(ctx, 'ok'); yield { type: 'done' } })
    const { ws, origin } = await newWorkstream('judge-off')
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', verification: { outcome: 'skipped', verdict: null } })
    expect(verifyCalls).toBe(0)
    expect((await thread(origin)).find(m => m.origin === `workstream:${ws.id}`)!.content).not.toContain('⚠')
  })
})

// ── the verifying window ────────────────────────────────────────────────────────────────────────

describe('outcome judge — while verifying', () => {
  it('shows stateDetail "verifying" (and the DTO says so) while the verifier runs; cleared on the send-back', async () => {
    const g = gate()
    script = [async () => { await g.p; return PARTIAL }, V()]
    const { runFn, drive } = harness(async function* (ctx) {
      step(ctx)
      await finish(ctx, 'S')
      yield { type: 'tool-result', name: 'finish_workstream', summary: 'x' }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('verifying')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    const during = await until(async () => { const r = await getWorkstream(ws.id); return r?.stateDetail === 'verifying' ? r : null })
    expect(during.state).toBe('running')
    expect((await workstreamDTO(during)).stateDetail).toBe('verifying')
    g.open()
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', stateDetail: null, sendBacks: 1 })
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done', sendBacks: 1, stateDetail: null })
  })

  it('Stop during verification (the REAL verifier, cancelled): it does NOT finish — paused, counter untouched, detail cleared', async () => {
    let calls = 0
    const waitForAbort = (_m: ResolvedModel, _p: unknown, signal: AbortSignal) => { calls++; return new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) }
    outcomeDeps.verify = (e, o) => verifyOutcome(e, { ...o, chain: async () => [{ label: 'fake' } as unknown as ResolvedModel], call: waitForAbort })
    let out: Awaited<ReturnType<typeof finish>> | undefined
    const { runFn } = harness(async function* (ctx) {
      step(ctx)
      out = await finish(ctx, 'S')
      if (ctx.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('stop')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'verifying' && calls > 0)
    abortRun((await getWorkstream(ws.id))!.currentRunId!)
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(out).toMatchObject({ result: { ok: false, error: expect.stringMatching(/was stopped while its outcome was being checked/) } })
    const row = (await getWorkstream(ws.id))!
    expect(row).toMatchObject({ state: 'paused', sendBacks: 0, stateDetail: null, summary: null })
    expect((await thread(origin)).some(m => m.origin === `workstream:${ws.id}` && /done/.test(m.content))).toBe(false)
  })

  it('cancel during verification: the verification is abandoned, the finish refused → cancelled (never done)', async () => {
    const g = gate()
    let aborted = false
    outcomeDeps.verify = async (_e, o) => {
      verifyCalls++
      o.signal?.addEventListener('abort', () => { aborted = true; g.open() }, { once: true })
      await g.p
      return V()  // a late `met` must not finish a cancelled workstream
    }
    let out: Awaited<ReturnType<typeof finish>> | undefined
    const { runFn } = harness(async function* (ctx) { step(ctx); out = await finish(ctx, 'S'); yield { type: 'done' } })
    const { ws } = await newWorkstream('cancel')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'verifying' && verifyCalls > 0)
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(aborted).toBe(true)
    expect(out).toMatchObject({ result: { ok: false, error: expect.stringMatching(/was cancelled while its outcome was being checked/) } })
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'cancelled', summary: null, sendBacks: 0 })
    expect(texts.join('\n')).not.toMatch(/Workstream done/)
  })

  it('a restart mid-verification never double-finishes: the recovered segment finishes once; the dead one\'s late verdict changes nothing', async () => {
    const g = gate()
    script = [async () => { await g.p; return PARTIAL }, V({ confidence: 0.99 })]
    let lateResult: Awaited<ReturnType<typeof finish>> | undefined
    const { runFn } = harness(async function* (ctx, _m, seg) {
      step(ctx)
      const r = await finish(ctx, `SUMMARY-SEG${seg}`)
      if (seg === 0) lateResult = r
      yield { type: 'done' }
    })
    const { ws, origin } = await newWorkstream('restart')
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await until(async () => (await getWorkstream(ws.id))?.stateDetail === 'verifying' && verifyCalls > 0)
    // The worker "dies": its segment row is recovered by another (stale owner) and re-enqueued.
    const runA = (await getWorkstream(ws.id))!.currentRunId!
    await useDb().update(agentRuns).set({ owner: 'dead-boot', aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, runA))
    expect(await recoverStale({ onlyConversations: [ws.conversationId] })).toBe(1)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', stateDetail: null, lastOutcome: 'interrupted' })
    // The recovered segment runs and finishes (met).
    expect(await pumpOnce({ onlyConversations: [ws.conversationId], rekick: false, run: runFn })).toBe(1)
    await until(async () => (await getWorkstream(ws.id))?.state === 'done')
    // Now the dead segment's verifier answers (partial): no send-back, no second finish, no second note.
    g.open()
    expect(await waitForInFlight(10_000)).toBe(true)
    expect(lateResult).toMatchObject({ result: { ok: false, error: 'the workstream is no longer running' } })
    const row = (await getWorkstream(ws.id))!
    expect(row).toMatchObject({ state: 'done', summary: 'SUMMARY-SEG1', sendBacks: 0, verification: { verdict: 'met', confidence: 0.99, outcome: 'finished' } })
    expect((await thread(origin)).filter(m => m.origin === `workstream:${ws.id}`)).toHaveLength(1)
    expect(texts.filter(t => t.includes('Workstream done'))).toHaveLength(1)
  })
})

// ── coordinators + evidence ─────────────────────────────────────────────────────────────────────

async function childRow(parent: { id: string }, o: { goal: string; state: 'done' | 'failed' | 'running'; summary?: string; verification?: unknown }) {
  const conv = await createConversation({ title: `T85 child ${o.goal}` })
  convIds.push(conv.id)
  const [r] = await useDb().insert(workstreams).values({
    conversationId: conv.id, goal: o.goal, state: o.state, budget: { maxSteps: 10, maxWallMs: 60_000 }, used: { steps: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    parentId: parent.id, isChild: true, summary: o.summary ?? null, verification: o.verification ?? null, ...(o.state === 'running' ? {} : { finishedAt: new Date() })
  }).returning()
  wsIds.push(r!.id)
  return r!
}

describe('outcome judge — coordinators and evidence', () => {
  it('a coordinator with a live child is refused BEFORE any verification; once its children ended, the verifier sees each one (state, summary, own verification)', async () => {
    const results: Array<Awaited<ReturnType<typeof finish>>> = []
    const { drive } = harness(async function* (ctx) {
      step(ctx)
      results.push(await finish(ctx, 'MERGED: A found prices, B failed'))
      yield { type: 'tool-result', name: 'finish_workstream', summary: 'x' }
      yield { type: 'done' }
    })
    const { ws } = await newWorkstream('coordinator', { toolsets: ['coordinator'] })
    const live = await childRow(ws, { goal: 'T85 child running', state: 'running' })
    await childRow(ws, { goal: 'T85 child A', state: 'done', summary: 'A: prices found', verification: { verdict: 'met', confidence: 0.9, gaps: [], nextStep: null, model: 'm', latencyMs: 1, outcome: 'finished', sendBacks: 0, at: new Date().toISOString() } })
    await childRow(ws, { goal: 'T85 child B', state: 'failed', summary: null })
    // Segment 1: refused (a child still going) — the verifier is never asked.
    await drive(ws.conversationId, 1)
    expect(results[0]!.result).toMatchObject({ ok: false, error: expect.stringMatching(/still going/) })
    expect(verifyCalls).toBe(0)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'running', sendBacks: 0, verification: null })
    await patchWorkstream(live.id, { state: 'cancelled', finishedAt: new Date() })
    await drive(ws.conversationId)
    expect(await getWorkstream(ws.id)).toMatchObject({ state: 'done' })
    expect(verifyCalls).toBe(1)
    const e = judged[0]!
    expect(e.totalChildren).toBe(3)
    expect(e.children!.map(c => [c.goal, c.state, c.summary, c.verification?.verdict ?? null])).toEqual([
      ['T85 child running', 'cancelled', null, null],
      ['T85 child A', 'done', 'A: prices found', 'met'],
      ['T85 child B', 'failed', null, null]
    ])
  })

  it('buildOutcomeEvidence reads THIS bus namespace\'s run_events for the conversation: calls paired, flagged, capped at 60 with the total', async () => {
    const conv = await createConversation({ title: 'T85 evidence' })
    convIds.push(conv.id)
    const runId = crypto.randomUUID()
    const rows: Array<{ type: string; chunk: Record<string, unknown> }> = []
    for (let i = 0; i < 62; i++) {
      rows.push({ type: 'chunk', chunk: { type: 'tool-input-available', toolCallId: `c${i}`, toolName: i === 61 ? 'web_fetch' : 'bash', input: { command: `echo ${i}` }, dynamic: true } })
      rows.push({ type: 'chunk', chunk: { type: 'tool-output-available', toolCallId: `c${i}`, output: { summary: `ran ${i}`, value: { stdout: 'x'.repeat(2000) } }, dynamic: true } })
    }
    rows.push({ type: 'chunk', chunk: { type: 'data-output_warning', id: 'c61', data: { toolCallId: 'c61', source: 'web', reasons: ['override'], score: 5 } } })
    rows.push({ type: 'chunk', chunk: { type: 'text-delta', id: 't', delta: 'chatter' } })
    await useDb().insert(runEvents).values(rows.map((r, i) => ({ ns: NS, runId, conversationId: conv.id, seq: i + 1, type: r.type, payload: r })))
    // Another namespace's rows for the same conversation are not this run's evidence.
    const otherRun = crypto.randomUUID()
    await useDb().insert(runEvents).values({ ns: `${NS}-other`, runId: otherRun, conversationId: conv.id, seq: 1, type: 'chunk', payload: { type: 'chunk', chunk: { type: 'tool-input-available', toolCallId: 'zz', toolName: 'gmail_send', input: {} } } })
    try {
      const e = await buildOutcomeEvidence({ goal: 'g', summary: 's', conversationId: conv.id })
      expect(e.totalCalls).toBe(62)
      expect(e.calls).toHaveLength(60)
      expect(e.calls[0]).toMatchObject({ tool: 'bash', args: '{"command": "echo 2"}' })
      expect(e.calls.at(-1)).toMatchObject({ tool: 'web_fetch', flagged: 'web', result: expect.stringMatching(/^ran 61 — \{"stdout": "x+/) })
      expect(e.calls.at(-1)!.result.length).toBeLessThanOrEqual(300)
      expect(e.calls.some(c => c.tool === 'gmail_send')).toBe(false)
      expect(e.workspace).toBeNull()
    } finally {
      await useDb().delete(runEvents).where(eq(runEvents.ns, `${NS}-other`))
    }
  })

  it('buildWorkstreamEvidence diffs the workstream\'s OWN workspace (a shared child: its coordinator\'s) through the runner, offline', async () => {
    const { ws } = await newWorkstream('diff')
    const seen: string[] = []
    const diff: WorkspaceDiffDeps = { exec: async (id) => { seen.push(id); return { exitCode: 0, stdout: `diff of ${id}`, stderr: '' } }, secrets: async () => [] }
    const row = (await getWorkstream(ws.id))!
    const [w] = await useDb().select().from(workspaces).where(eq(workspaces.workstreamId, ws.id))
    expect((await buildWorkstreamEvidence(row, 'S', { diff })).workspace).toBe(`diff of ${w!.id}`)
    const shared = await childRow(ws, { goal: 'T85 shared child', state: 'running' })
    await useDb().update(workstreams).set({ workspaceMode: 'shared' }).where(eq(workstreams.id, shared.id))
    const sharedRow = (await getWorkstream(shared.id))!
    expect((await buildWorkstreamEvidence(sharedRow, 'S', { diff })).workspace).toBe(`diff of ${w!.id}`)
    expect(seen).toEqual([w!.id, w!.id])
    // The real default runs the script OFFLINE (no network, no secrets, never taints the workspace).
    const { workspaceDiffDeps } = await import('@mymind/core/lib/agent/judge/outcome')
    const { setWorkspaceRuntime } = await import('@mymind/core/lib/sandbox/runtime')
    const execs: unknown[] = []
    setWorkspaceRuntime({ manager: { exec: async (id: string, _s: string, o: unknown) => { execs.push({ id, o }); return { exitCode: 0, stdout: '', stderr: '' } } } } as never)
    try { await workspaceDiffDeps.exec(w!.id, 'true', { timeoutSec: 30, capBytes: 1000 }) } finally { setWorkspaceRuntime(null) }
    expect(execs).toEqual([{ id: w!.id, o: { timeoutSec: 30, capBytes: 1000, offline: true } }])
    await patchWorkstream(shared.id, { state: 'cancelled' })
    await controlWorkstream({ workstreamId: ws.id, action: 'cancel' })
  })
})
