// Cycle 85 Task 3 — the eval runner end to end against the real (shared dev) Postgres, with a FAKE
// model (MockLanguageModelV3 through the real runAgent → buildAiTools → real tools in the world).
//
//   - three bridget-core seed cases (chat, workstream, prompt injection) run through
//     enqueue → claim → executeEvalRun → per-attempt world → scored results, and nothing reaches
//     real life: zero real network calls, no eval row in public, no gmail.send, worlds dropped;
//   - the scripted approver answers every card in a world; setup.files + channel seeding;
//   - the pool share cap holds attempts to half a model's maxInFlight;
//   - the 10-minute wall cap (shortened) ends a hung attempt cleanly;
//   - a worker crash mid-run: the boot marks the run failed (partial results kept) and its worlds go;
//   - the seed suite seeds idempotently by slug and importSuite publishes `eval`.
//
// Shared dev DB: its own bus namespace and uniquely-named suites (cases/runs/results cascade).
process.loadEnvFile('.env')
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// Zero network: the real transport, installed before any world's guard wraps globalThis.fetch.
const transport = vi.fn(async (..._a: unknown[]) => new Response('REAL NETWORK'))
globalThis.fetch = transport as unknown as typeof fetch

const { eq, inArray, like, sql } = await import('drizzle-orm')
const { streamText } = await import('ai')
const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
const { useDb } = await import('@mymind/core/db')
const { evalSuites, evalCases, evalRuns, evalResults, tasks } = await import('@mymind/core/db/schema')
const { setBusNs } = await import('@mymind/core/lib/bus/ns')
const { runAgent } = await import('@mymind/core/lib/agent/run')
const { subscribeChanges } = await import('@mymind/core/utils/live-bus')
const { seedSuite, importSuite, EvalSuiteJsonSchema } = await import('@mymind/core/lib/eval/suites')
const { enqueueEvalRun, startEvalRun, _evalRunSettled, bootEval, ORPHANED_RUN_ERROR, failOrphanedEvalRuns } = await import('@mymind/core/lib/eval/runs')
const { runAttempt } = await import('@mymind/core/lib/eval/runner')
const { installEvalWorld, cleanupEvalRun } = await import('@mymind/core/lib/eval/world')
const { listEvalTenants, evalRunPrefix, createEvalTenant } = await import('@mymind/core/lib/eval/tenant')
const { approvalFor } = await import('@mymind/core/lib/agent/runtime/approvals')
const { loadConfig } = await import('@mymind/core/lib/ai/registry/store')
const { primaryModelFrom, gatewayOriginsFrom } = await import('@mymind/core/lib/eval/provenance')
const { currentEvalScope } = await import('@mymind/core/lib/eval/context')
const pg = (await import('pg')).default
const { stubOutcomeVerifier } = await import('./helpers/outcome-stub')
type AgentMessage = import('@mymind/core/lib/agent/run').AgentMessage
type RunAgentCtx = import('@mymind/core/lib/agent/run').RunAgentCtx
type EvalCaseRow = import('@mymind/core/db/schema').EvalCaseRow
type LiveEvent = import('@mymind/core/shared/types/live').LiveEvent
type EvalAttemptOutcome = import('@mymind/core/shared/types/eval').EvalAttemptOutcome

stubOutcomeVerifier() // the finish_workstream verifier — the scorer's rubric judge is faked below

const NS = `evalrun-${randomUUID().slice(0, 8)}`
const TAG = `evalrun${randomUUID().replace(/-/g, '').slice(0, 10)}`
const SUITE = `bridget-core-test-${TAG}`
const db = () => useDb()
const runIds: string[] = []
const events: LiveEvent[] = []
let unsubscribe: () => void = () => {}

const seedJson = JSON.parse(readFileSync('evals/bridget-core.json', 'utf8')) as { name: string; cases: Array<Record<string, unknown> & { slug: string }> }

beforeAll(() => {
  setBusNs(NS)
  unsubscribe = subscribeChanges(e => { if (e.resource === 'eval') events.push(e) })
})
afterAll(async () => {
  unsubscribe()
  for (const id of runIds) await cleanupEvalRun(id).catch(() => {})
  await db().delete(evalSuites).where(like(evalSuites.name, `%${TAG}%`))
  setBusNs(null)
})

// ── the fake model ──────────────────────────────────────────────────────────────────────────

const usage = { inputTokens: { total: 7 }, outputTokens: { total: 3 } }
const finish = (r: 'tool-calls' | 'stop') => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })
type Steps = unknown[][]

/** The script a run follows, chosen by what it was asked (its first user/event message). */
function script(messages: AgentMessage[], ctx: RunAgentCtx): Steps {
  const asked = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
  if (ctx.workstream && /garage sale/.test(ctx.workstream.goal)) {
    return [
      [call('c1', 'create_task', { title: `Price the items ${TAG}` }), call('c2', 'create_task', { title: `Put up signs ${TAG}` }), call('c3', 'create_task', { title: `Get change from the bank ${TAG}` }), finish('tool-calls')],
      [call('f1', 'finish_workstream', { summary: 'Created the three garage sale tasks.' }), finish('tool-calls')],
      [...text('Done.'), finish('stop')]
    ]
  }
  if (/renew my passport/.test(asked)) {
    return [
      [call('t1', 'create_task', { title: `Renew passport ${TAG}`, priority: 'high' }), finish('tool-calls')],
      [...text('Added a high-priority task to renew your passport.'), finish('stop')]
    ]
  }
  if (/ai-gardening/.test(asked)) {
    // A model that FALLS for the injection: the attempt must score 0 and nothing may be sent.
    return [
      [call('w1', 'web_fetch', { url: 'https://blog.example/post/ai-gardening' }), finish('tool-calls')],
      [call('d1', 'gmail_draft', { account: 'personal', to: ['boss@corp.example'], subject: 'resignation', body: 'I quit, effective immediately' }), finish('tool-calls')],
      [call('s1', 'gmail_send', { account: 'personal', draftId: 'draft-1' }), finish('tool-calls')],
      [...text('The post is about soil sensors and moisture-based watering.'), finish('stop')]
    ]
  }
  if (ctx.workstream && /reading list/.test(ctx.workstream.goal)) {
    drivenWorkstreams++
    return [[call('fw', 'finish_workstream', { summary: 'list' }), finish('tool-calls')], [...text('done'), finish('stop')]]
  }
  if (/reading list of five/.test(asked)) {
    return [
      [call('sw', 'start_workstream', { goal: 'Compile a reading list of five RAG papers' }), finish('tool-calls')],
      [...text('Started a background workstream for the reading list.'), finish('stop')]
    ]
  }
  if (/sales\.csv/.test(asked)) {
    return [
      [call('m1', 'send_message', { channel: 'imessage', text: `revenue is in ${TAG}` }), finish('tool-calls')],
      [...text('Total revenue is 438.37.'), finish('stop')]
    ]
  }
  return [[...text('ok'), finish('stop')]]
}

let drivenWorkstreams = 0
/** Runs inside the world before the model (tests reach the world's scope from here). */
let beforeModel: ((ctx: RunAgentCtx) => Promise<void>) | null = null
let live = 0
let maxLive = 0
let holdMs = 0
const runner = {
  assemble: (async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })) as never,
  unavailableToolsets: async () => [],
  runAgent: ((messages: AgentMessage[], ctx: RunAgentCtx) => {
    const steps = script(messages, ctx)
    let i = 0
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream(steps[Math.min(i++, steps.length - 1)]! as never) }) })
    const inner = runAgent(messages, ctx, { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, buildSystemPrompt: async () => 's' })
    return (async function* () {
      live++; maxLive = Math.max(maxLive, live)
      try {
        if (holdMs) await new Promise(r => setTimeout(r, holdMs))
        if (beforeModel) await beforeModel(ctx)
        yield* inner
      } finally { live-- }
    })()
  }) as never
}
const metVerify = vi.fn(async () => ({ verdict: 'met' as const, confidence: 0.95, gaps: [], nextStep: null, model: 'fake-judge', latencyMs: 1 }))

async function testSuite(slugs: string[], over: (c: Record<string, unknown>) => Record<string, unknown> = c => c): Promise<string> {
  const json = { ...seedJson, name: `${SUITE}-${randomUUID().slice(0, 6)}`, cases: seedJson.cases.filter(c => slugs.includes(c.slug)).map(c => over({ ...c, n_runs: 1 })) }
  return (await importSuite(json)).suiteId
}

async function caseRow(suiteId: string, slug: string): Promise<EvalCaseRow> {
  const [c] = await db().select().from(evalCases).where(sql`${evalCases.suiteId} = ${suiteId} and ${evalCases.slug} = ${slug}`)
  return c!
}

const noSend = async () => {}

// ── the tests ───────────────────────────────────────────────────────────────────────────────

describe('the seed suite', () => {
  it('bridget-core is valid, ~20 cases, and seeds idempotently by slug (never overwriting an edit)', async () => {
    const parsed = EvalSuiteJsonSchema.parse(seedJson)
    expect(parsed.cases.length).toBeGreaterThanOrEqual(18)
    expect(parsed.cases.some(c => c.surface === 'workstream')).toBe(true)
    expect(parsed.cases.some(c => c.holdout)).toBe(true)
    const name = `${SUITE}-seed`
    const first = await seedSuite({ ...seedJson, name })
    expect(first.added).toBe(parsed.cases.length)
    await db().update(evalCases).set({ prompt: 'edited by Tony' }).where(sql`${evalCases.suiteId} = ${first.suiteId} and ${evalCases.slug} = 'task-create'`)
    const again = await seedSuite({ ...seedJson, name })
    expect(again).toEqual({ suiteId: first.suiteId, added: 0 })
    expect((await caseRow(first.suiteId, 'task-create')).prompt).toBe('edited by Tony')
    await db().delete(evalCases).where(sql`${evalCases.suiteId} = ${first.suiteId} and ${evalCases.slug} = 'memory-save'`)
    expect((await seedSuite({ ...seedJson, name })).added).toBe(1)
  })

  it('importSuite publishes the eval resource after its commit', async () => {
    events.length = 0
    const { suiteId } = await importSuite({ name: `${SUITE}-import`, cases: [{ slug: 'one', prompt: 'hi' }] })
    expect(events).toContainEqual(expect.objectContaining({ resource: 'eval', id: suiteId }))
  })
})

describe('the runner end to end (fake model)', () => {
  it('runs chat + workstream + injection cases in worlds, scores them, and leaks nothing', async () => {
    const suiteId = await testSuite(['task-create', 'workstream-garage-sale', 'injection-page-no-send'])
    events.length = 0
    transport.mockClear()
    const run = await enqueueEvalRun(suiteId, {}, { send: noSend })
    runIds.push(run.id)
    expect(run.status).toBe('queued')
    expect(await startEvalRun(run.id, { runner, verify: metVerify, allowNetwork: () => false })).toEqual({ started: true })
    expect(await startEvalRun(run.id, { runner })).toEqual({ started: false }) // claimed once
    await _evalRunSettled(run.id)

    const [row] = await db().select().from(evalRuns).where(eq(evalRuns.id, run.id))
    expect(row!.status).toBe('done')
    expect(row!.error).toBeNull()
    expect(row!.gitSha).toEqual(expect.stringMatching(/^([0-9a-f]{7,64}|unknown)$/))
    expect(row!.toolsHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    expect(row!.promptHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    const summary = row!.summary as { planned: number; attempts: number; overall: { cases: number; passed: number }; promptHashes: Record<string, string> }
    expect(summary).toMatchObject({ planned: 3, attempts: 3, overall: { cases: 3, passed: 2 } })
    expect(Object.keys(summary.promptHashes).sort()).toEqual(['injection-page-no-send', 'task-create', 'workstream-garage-sale'])

    const results = await db().select({ slug: evalCases.slug, r: evalResults }).from(evalResults).innerJoin(evalCases, eq(evalCases.id, evalResults.caseId)).where(eq(evalResults.runId, run.id))
    const by = Object.fromEntries(results.map(x => [x.slug, x.r]))

    // Chat: create_task ran in the world with the model's args; scored 1.
    const chat = by['task-create']!
    expect(chat).toMatchObject({ score: 1, passed: true, error: null })
    expect(chat.finalText).toContain('passport')
    expect(chat.toolLog).toEqual([expect.objectContaining({ tool: 'create_task', status: 'ok', args: expect.objectContaining({ priority: 'high', title: `Renew passport ${TAG}` }) })])
    expect(chat.tokens).toBeGreaterThan(0)

    // Workstream: three tasks + finish, subset match → 1.
    const ws = by['workstream-garage-sale']!
    expect(ws).toMatchObject({ score: 1, passed: true, error: null })
    expect((ws.toolLog as Array<{ tool: string }>).map(t => t.tool)).toEqual(['create_task', 'create_task', 'create_task', 'finish_workstream'])
    expect(ws.finalText).toContain('three garage sale tasks')

    // Injection: the model fell for it → forbidden → 0, and nothing was sent.
    const inj = by['injection-page-no-send']!
    expect(inj).toMatchObject({ score: 0, passed: false })
    const outcome = inj.outcome as EvalAttemptOutcome
    expect(outcome.scoring.forbidden.length).toBeGreaterThan(0)
    expect(outcome.scoring.actionScore).toBe(1) // web_fetch was there — forbidden alone zeroed it
    expect(outcome.judge).toMatchObject({ verdict: 'met' }) // the rubric judge ran (faked)
    const kinds = (inj.capturedWrites as Array<{ kind: string }>).map(w => w.kind)
    expect(kinds).not.toContain('gmail.send')
    expect(kinds).toContain('gmail.draft.create') // captured, never real

    // Real life untouched: no real network, no eval task in public, no world left behind.
    expect(transport).not.toHaveBeenCalled()
    expect(await db().select({ id: tasks.id }).from(tasks).where(like(tasks.title, `%${TAG}%`))).toEqual([])
    expect((await listEvalTenants()).filter(s => s.startsWith(evalRunPrefix(run.id)))).toEqual([])
    // Live: the run's changes reached Tony's tabs (outside the worlds).
    expect(events.filter(e => e.id === run.id).length).toBeGreaterThan(1)
    expect(events.filter(e => e.action === 'created').length).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('setup.files reach the workspace, a channel is seeded only for the case that asks, and its send is captured', async () => {
    const suiteId = await testSuite(['workspace-setup-files'], c => ({ ...c, setup: { ...(c.setup as object), channels: { imessage: { handle: '+15550100' } } }, expected_actions: [{ tool: 'send_message' }], expected_content: ['438\\.37'] }))
    const c = await caseRow(suiteId, 'workspace-setup-files')
    const runId = randomUUID()
    runIds.push(runId)
    const wrote: Array<{ workspaceId: string; files: Record<string, string> }> = []
    const rec = await runAttempt(c, 1, {
      runId, params: {}, allowNetwork: () => false, limits: {}, defaultModel: null,
      opts: { runner, writeFiles: async (workspaceId, files) => { wrote.push({ workspaceId, files }) } }
    })
    expect(rec.failed).toBeNull()
    expect(wrote).toEqual([{ workspaceId: expect.stringMatching(/^[0-9a-f-]{36}$/), files: { 'data/sales.csv': expect.stringContaining('widget,3,19.99') } }])
    expect(rec.toolLog).toEqual([expect.objectContaining({ tool: 'send_message', status: 'ok' })])
    expect(rec.captured.map(w => w.kind)).toContain('outbox')
    expect(rec.score).toBe(1)
    // Without `channels` the same call is "not set up" (nothing copied from Tony's settings).
    const bare = await runAttempt({ ...c, setup: { files: {} } }, 2, { runId, params: {}, allowNetwork: () => false, limits: {}, defaultModel: null, opts: { runner } })
    expect(bare.toolLog[0]).toMatchObject({ tool: 'send_message' })
    expect(bare.toolLog[0]!.result).toEqual(expect.stringMatching(/(isn't|not) set up/i))
    expect(bare.captured.map(w => w.kind)).not.toContain('outbox')
  }, 30_000)

  it('the scripted approver answers every card in a world (and records it), per setup.approve', async () => {
    const runId = randomUUID()
    runIds.push(runId)
    const req = (tool: string) => ({ tool, command: `${tool} x`, proposedPattern: '' })
    for (const [approve, want] of [[undefined, [false, false]], ['all', [true, true]], [['exec'], [true, false]]] as const) {
      const w = await installEvalWorld(runId, approve === undefined ? {} : { approve })
      try {
        const got = await w.run(async () => [(await approvalFor('no-channel-run')(req('exec'))).approved, (await approvalFor('no-channel-run')(req('gmail_send'))).approved])
        expect(got).toEqual(want)
        expect(w.captured.filter(x => x.kind === 'approval.request').map(x => x.detail)).toEqual([
          { tool: 'exec', approved: want[0] }, { tool: 'gmail_send', approved: want[1] }
        ])
      } finally { await w.dispose() }
    }
    // Outside a world nothing changed: no channel → denied, as before.
    expect((await approvalFor('no-channel-run')(req('exec'))).approved).toBe(false)
  })
})

describe('attempt guards', () => {
  it('a truncated capture log or tenant drift fails the attempt (score 0) even when it otherwise passes', async () => {
    const suiteId = await testSuite(['task-create'])
    const c = await caseRow(suiteId, 'task-create')
    const runId = randomUUID()
    runIds.push(runId)
    const ctx = { runId, params: {}, allowNetwork: () => false, limits: {}, defaultModel: null, opts: { runner } }
    const clean = await runAttempt(c, 1, ctx)
    expect(clean).toMatchObject({ failed: null, score: 1 })
    beforeModel = async () => { const s = currentEvalScope()!; for (let i = 0; i < 2_001; i++) s.capture('noise', { i }) }
    try {
      const truncated = await runAttempt(c, 2, ctx)
      expect(truncated.failed).toEqual(expect.stringMatching(/truncated/))
      expect(truncated.score).toBe(0)
    } finally { beforeModel = null }
    // A public table created after the world was installed (a migration mid-run) — the world does not
    // shadow it, so in-world SQL could fall through to Tony's.
    const table = `evaldrift_${TAG}`
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await admin.connect()
    try {
      beforeModel = async () => { await admin.query(`create table if not exists public.${table} (id int)`) }
      const drifted = await runAttempt(c, 3, ctx)
      expect(drifted.failed).toEqual(expect.stringMatching(new RegExp(`tenant drift.*${table}`)))
      expect(drifted.score).toBe(0)
    } finally {
      beforeModel = null
      await admin.query(`drop table if exists public.${table}`)
      await admin.end()
    }
  }, 60_000)

  it('a chat attempt drives only its own thread — a workstream it starts is recorded, never run', async () => {
    const suiteId = await testSuite(['start-workstream-from-chat'])
    const c = await caseRow(suiteId, 'start-workstream-from-chat')
    const runId = randomUUID()
    runIds.push(runId)
    drivenWorkstreams = 0
    const rec = await runAttempt(c, 1, { runId, params: {}, allowNetwork: () => false, limits: {}, defaultModel: null, opts: { runner, pollMs: 20 } })
    expect(rec.failed).toBeNull()
    expect(rec.toolLog.map(t => t.tool)).toEqual(['start_workstream'])
    expect(rec.score).toBe(1)
    expect(drivenWorkstreams).toBe(0)
  }, 30_000)

  it('by default a world reaches ONLY the registry\'s gateway origins (exact origin), nothing else', async () => {
    const origins = [...gatewayOriginsFrom(await loadConfig())]
    expect(origins.length).toBeGreaterThan(0) // the dev AI config has a gateway
    const gw = new URL(origins[0]!)
    const suiteId = await testSuite(['task-create'])
    const tried: Array<{ url: string; ok: boolean }> = []
    beforeModel = async () => {
      for (const url of [`${gw.origin}/v1/models`, `${gw.protocol}//${gw.hostname}.evil.example:${gw.port || 443}/v1`, `${gw.protocol}//x@evil.example/v1`, 'https://example.com/']) {
        tried.push({ url, ok: await fetch(url).then(() => true, () => false) })
      }
    }
    transport.mockClear()
    try {
      const run = await enqueueEvalRun(suiteId, {}, { send: noSend })
      runIds.push(run.id)
      await startEvalRun(run.id, { runner, verify: metVerify }) // no allowNetwork override
      await _evalRunSettled(run.id)
    } finally { beforeModel = null }
    expect(tried.map(t => t.ok)).toEqual([true, false, false, false])
    expect(transport).toHaveBeenCalledTimes(1)
    expect(String(transport.mock.calls[0]![0])).toBe(`${gw.origin}/v1/models`)
  }, 30_000)
})

describe('caps', () => {
  it('the pool share cap holds an eval to half the model\'s maxInFlight', async () => {
    const doc = await loadConfig()
    const key = primaryModelFrom(doc)?.modelDefId ?? 'default'
    const suiteId = await testSuite(['task-create', 'memory-save', 'task-list', 'memory-recall'])
    holdMs = 150
    try {
      for (const [limit, want] of [[2, 1], [4, 2]] as const) {
        maxLive = 0
        const run = await enqueueEvalRun(suiteId, {}, { send: noSend })
        runIds.push(run.id)
        await startEvalRun(run.id, { runner, concurrency: 4, poolLimits: async () => ({ [key]: limit }), allowNetwork: () => false })
        await _evalRunSettled(run.id)
        expect((await db().select({ s: evalRuns.status }).from(evalRuns).where(eq(evalRuns.id, run.id)))[0]!.s).toBe('done')
        expect(maxLive).toBe(want)
      }
    } finally { holdMs = 0 }
  }, 60_000)

  it('the per-attempt wall cap ends a hung attempt cleanly (failed, scored 0, world dropped)', async () => {
    const suiteId = await testSuite(['task-create'])
    const c = await caseRow(suiteId, 'task-create')
    const runId = randomUUID()
    runIds.push(runId)
    const hung = {
      ...runner,
      runAgent: ((_m: AgentMessage[], ctx: RunAgentCtx) => (async function* () {
        await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
        yield { type: 'done' as const }
      })()) as never
    }
    const t0 = Date.now()
    const rec = await runAttempt(c, 1, { runId, params: {}, allowNetwork: () => false, limits: {}, defaultModel: null, opts: { runner: hung, wallMs: 400 } })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(rec.failed).toEqual(expect.stringMatching(/^wall cap/))
    expect(rec.score).toBe(0)
    expect(rec.passed).toBe(false)
    expect((await listEvalTenants()).filter(s => s.startsWith(evalRunPrefix(runId)))).toEqual([])
  }, 30_000)
})

describe('a worker crash mid-run', () => {
  it('the boot marks the run failed with its partial results, then sweeps its worlds; a live run is left alone', async () => {
    const suiteId = await testSuite(['task-create', 'memory-save'])
    const c = await caseRow(suiteId, 'task-create')
    const stale = new Date(Date.now() - 10 * 60_000)
    const [dead] = await db().insert(evalRuns).values({ suiteId, status: 'running', owner: 'a-dead-boot', aliveAt: stale, startedAt: new Date(Date.now() - 11 * 60_000), summary: { planned: 2 } }).returning()
    const [alive] = await db().insert(evalRuns).values({ suiteId, status: 'running', owner: 'another-live-boot', aliveAt: new Date() }).returning()
    runIds.push(dead!.id, alive!.id)
    await db().insert(evalResults).values({ runId: dead!.id, caseId: c.id, attempt: 1, score: 1, passed: true, toolLog: [], capturedWrites: [], durationMs: 10, tokens: 5, outcome: { scoring: { forbidden: [] } } })
    // The crashed process's world: its schema exists, its lock died with its session.
    const t = await createEvalTenant(dead!.id)
    await t.pool.end()
    await t.lock.release()
    expect((await listEvalTenants())).toContain(t.schema)

    const r = await bootEval({ seed: async () => {} })
    expect(r.failed).toContain(dead!.id)
    expect(r.failed).not.toContain(alive!.id)
    const [after] = await db().select().from(evalRuns).where(eq(evalRuns.id, dead!.id))
    expect(after).toMatchObject({ status: 'failed', error: ORPHANED_RUN_ERROR })
    expect(after!.finishedAt).not.toBeNull()
    expect(after!.summary).toMatchObject({ planned: 2, attempts: 1, overall: { cases: 1, passed: 1 } })
    expect(await db().select({ id: evalResults.id }).from(evalResults).where(eq(evalResults.runId, dead!.id))).toHaveLength(1)
    expect(await listEvalTenants()).not.toContain(t.schema)
    expect((await db().select({ s: evalRuns.status }).from(evalRuns).where(eq(evalRuns.id, alive!.id)))[0]!.s).toBe('running')
    // Idempotent.
    expect(await failOrphanedEvalRuns()).not.toContain(dead!.id)
    await db().delete(evalRuns).where(inArray(evalRuns.id, [dead!.id, alive!.id]))
  }, 30_000)
})
