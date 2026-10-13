// Cycle 85 Task 4 — the /evals dashboard's read models and case writes against the shared dev DB
// (its own bus namespace and a uniquely-named suite; runs / results / cases cascade on delete).
process.loadEnvFile('.env')
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { ZodError } from 'zod'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { eq } = await import('drizzle-orm')
const { useDb } = await import('@mymind/core/db')
const { evalSuites, evalCases, evalRuns, evalResults } = await import('@mymind/core/db/schema')
const { setBusNs } = await import('@mymind/core/lib/bus/ns')
const { subscribeChanges } = await import('@mymind/core/utils/live-bus')
const { importSuite, updateCase, setCaseEnabled, EvalCaseConflictError } = await import('@mymind/core/lib/eval/suites')
const { listSuiteOverviews, getSuiteDetail, getRunView, getAttemptView, getCaseView } = await import('@mymind/core/lib/eval/dashboard')
type LiveEvent = import('@mymind/core/shared/types/live').LiveEvent

const NS = `evaldash-${randomUUID().slice(0, 8)}`
const NAME = `eval-dashboard-test-${randomUUID().slice(0, 8)}`
const events: LiveEvent[] = []
let unsubscribe: () => void = () => {}
let suiteId = ''
const caseIds: Record<string, string> = {}

const summary = (passRate: number, attempts: number, planned: number) => ({
  overall: { cases: 2, passed: 1, passRate, meanScore: passRate },
  nonHoldout: { cases: 2, passed: 1, passRate, meanScore: passRate },
  holdout: { cases: 0, passed: 0, passRate: null, meanScore: null },
  attempts, failedAttempts: 0, tokens: 10, durationMs: 1000, planned, cases: []
})

beforeAll(async () => {
  setBusNs(NS)
  unsubscribe = subscribeChanges(e => { if (e.resource === 'eval') events.push(e) })
  const r = await importSuite({
    name: NAME,
    cases: [
      { slug: 'alpha', prompt: 'a', expected_actions: [{ tool: 'create_task' }] },
      { slug: 'beta', prompt: 'b', rubric: 'r' },
      { slug: 'gamma', prompt: 'c', enabled: false }
    ]
  })
  suiteId = r.suiteId
  for (const c of await useDb().select().from(evalCases).where(eq(evalCases.suiteId, suiteId))) caseIds[c.slug] = c.id
})
afterAll(async () => {
  unsubscribe()
  await useDb().delete(evalSuites).where(eq(evalSuites.name, NAME))
  setBusNs(null)
})

describe('read models', () => {
  it('overview: case counts, the newest run (even running) and a done-only trend, oldest first', async () => {
    const t0 = Date.now() - 60_000
    const ins = (status: string, pass: number, at: number) => useDb().insert(evalRuns).values({ suiteId, status, startedAt: new Date(at), summary: summary(pass, 2, 2) }).returning().then(r => r[0]!)
    const old = await ins('done', 0.5, t0)
    await ins('failed', 0.1, t0 + 1000)
    const recent = await ins('done', 1, t0 + 2000)
    const live = await ins('running', 0, t0 + 3000)
    const o = (await listSuiteOverviews()).find(s => s.id === suiteId)!
    expect(o).toMatchObject({ name: NAME, cases: 3, enabledCases: 2 })
    expect(o.lastRun!.id).toBe(live.id)
    expect(o.trend.map(p => [p.runId, p.passRate])).toEqual([[old.id, 0.5], [recent.id, 1]])
    await useDb().delete(evalRuns).where(eq(evalRuns.suiteId, suiteId))
  })

  it('a running run lists the cases it will run (its slugs, or every enabled case) before any result', async () => {
    const [byFilter] = await useDb().insert(evalRuns).values({ suiteId, status: 'running', params: { cases: ['gamma'] } }).returning()
    expect((await getRunView(byFilter!.id))!.cases.map(c => c.slug)).toEqual(['gamma'])
    const [all] = await useDb().insert(evalRuns).values({ suiteId, status: 'queued' }).returning()
    expect((await getRunView(all!.id))!.cases.map(c => c.slug)).toEqual(['alpha', 'beta'])
    // Finished: only the cases it actually scored.
    await useDb().update(evalRuns).set({ status: 'done' }).where(eq(evalRuns.id, all!.id))
    await useDb().insert(evalResults).values({ runId: all!.id, caseId: caseIds.beta!, attempt: 1, score: 0.5, passed: false })
    const v = (await getRunView(all!.id))!
    expect(v.cases.map(c => c.slug)).toEqual(['beta'])
    expect(v.suite).toEqual({ id: suiteId, name: NAME })
    await useDb().delete(evalRuns).where(eq(evalRuns.suiteId, suiteId))
  })

  it('run view results are light; the attempt view has the full result and flags a case edited since the run', async () => {
    const [run] = await useDb().insert(evalRuns).values({ suiteId, status: 'done', startedAt: new Date(Date.now() + 1000) }).returning()
    const outcome = {
      judge: { verdict: 'partial', confidence: 0.5, gaps: [], nextStep: null, model: 'm', latencyMs: 1 },
      scoring: { mode: 'ordered_subset', actionScore: 0, matched: [], unmatched: [0], extra: [0], forbidden: [{ forbidden: 0, call: 0 }], content: { pass: true, missing: [] }, outcomeMet: false, checks: { flagged: null, tainted: null, taintSources: [], approvalsMissing: [], forbiddenApprovals: [], pass: true }, failed: null },
      approvals: []
    }
    const [res] = await useDb().insert(evalResults).values({ runId: run!.id, caseId: caseIds.alpha!, attempt: 1, score: 0, passed: false, toolLog: [{ tool: 'delete_task', args: {}, status: 'ok', result: 'x', conversationId: 'c' }], finalText: 'done', outcome }).returning()
    const lite = (await getRunView(run!.id))!.results[0]!
    expect(lite).toMatchObject({ id: res!.id, forbidden: true, verdict: 'partial', score: 0 })
    expect(lite).not.toHaveProperty('toolLog')
    let a = (await getAttemptView(res!.id))!
    expect(a.result.toolLog).toHaveLength(1)
    expect(a.case).toMatchObject({ slug: 'alpha', editedSince: false })
    await new Promise(r => setTimeout(r, 1100))
    await updateCase(caseIds.alpha!, { ...(await getCaseView(caseIds.alpha!))!.json, prompt: 'a2' })
    a = (await getAttemptView(res!.id))!
    expect(a.case).toMatchObject({ editedSince: true, json: { prompt: 'a2' } })
    expect(await getAttemptView(randomUUID())).toBeNull()
    await useDb().delete(evalRuns).where(eq(evalRuns.suiteId, suiteId))
  })

  it('suite detail lists the cases (slug order) with their flags', async () => {
    const d = (await getSuiteDetail(suiteId))!
    expect(d.cases.map(c => [c.slug, c.enabled, c.hasRubric])).toEqual([['alpha', true, false], ['beta', true, true], ['gamma', false, false]])
    expect(await getSuiteDetail(randomUUID())).toBeNull()
  })
})

describe('case writes', () => {
  it('updateCase validates (nothing written on a ZodError), refuses a taken slug, publishes on success', async () => {
    const before = (await getCaseView(caseIds.beta!))!
    await expect(updateCase(caseIds.beta!, { ...before.json, n_runs: 99 })).rejects.toBeInstanceOf(ZodError)
    await expect(updateCase(caseIds.beta!, { ...before.json, slug: 'alpha' })).rejects.toBeInstanceOf(EvalCaseConflictError)
    expect((await getCaseView(caseIds.beta!))!.json).toEqual(before.json)
    events.length = 0
    const row = await updateCase(caseIds.beta!, { ...before.json, slug: 'beta-2', expected_content: ['ok'] })
    expect(row).toMatchObject({ slug: 'beta-2', expectedContent: ['ok'] })
    expect(events).toEqual([expect.objectContaining({ resource: 'eval', action: 'updated', id: caseIds.beta })])
    expect(await updateCase(randomUUID(), before.json)).toBeNull()
  })

  it('setCaseEnabled flips the flag and publishes', async () => {
    events.length = 0
    expect(await setCaseEnabled(caseIds.gamma!, true)).toMatchObject({ enabled: true })
    expect(events).toEqual([expect.objectContaining({ resource: 'eval', id: caseIds.gamma })])
    expect(await setCaseEnabled(randomUUID(), true)).toBeNull()
  })
})
