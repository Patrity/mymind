// Cycle 85 Task 4 (spec §3.5): the /evals dashboard's read models — suites with their last run and
// pass-rate trend, a suite's cases and run history, a run's attempts (light), one attempt in full.
// Read-only; the writes are the run lifecycle (runs.ts) and the case store (suites.ts).
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalCases, evalResults, evalRuns, evalSuites, type EvalCaseRow, type EvalResultRow } from '../../db/schema'
import type {
  EvalAttemptOutcome, EvalAttemptView, EvalCaseListItem, EvalCaseView, EvalMatchMode, EvalResultLite, EvalRunSummary,
  EvalRunView, EvalSuiteDetail, EvalSuiteOverview, EvalTrendPoint
} from '../../shared/types/eval'
import { evalResultDTO, evalRunDTO, listEvalRuns } from './runs'
import { caseJsonOf } from './suites'
import { sameScoringSpec, scoringSpecOf } from './scoring-spec'
import { attemptHitForbidden } from './score'

/** How many finished runs a suite's sparkline shows. */
export const TREND_RUNS = 20

/** The trend of a suite from its runs (newest first, as listed): done runs only, oldest first. */
export function trendOf(runs: ReturnType<typeof evalRunDTO>[], max = TREND_RUNS): EvalTrendPoint[] {
  return runs.filter(r => r.status === 'done').slice(0, max).reverse().map(r => ({
    runId: r.id, at: r.startedAt, status: r.status,
    passRate: r.summary?.nonHoldout.passRate ?? null, meanScore: r.summary?.nonHoldout.meanScore ?? null
  }))
}

export async function listSuiteOverviews(): Promise<EvalSuiteOverview[]> {
  const db = useDb()
  const suites = await db.select().from(evalSuites).orderBy(asc(evalSuites.name))
  if (!suites.length) return []
  const counts = await db.select({
    suiteId: evalCases.suiteId,
    n: sql<number>`count(*)::int`,
    enabled: sql<number>`count(*) filter (where ${evalCases.enabled})::int`
  }).from(evalCases).where(inArray(evalCases.suiteId, suites.map(s => s.id))).groupBy(evalCases.suiteId)
  const bySuite = new Map(counts.map(c => [c.suiteId, c]))
  return Promise.all(suites.map(async (s) => {
    const runs = await listEvalRuns(s.id, TREND_RUNS * 2)
    return {
      id: s.id, name: s.name, description: s.description, updatedAt: s.updatedAt.toISOString(),
      cases: bySuite.get(s.id)?.n ?? 0, enabledCases: bySuite.get(s.id)?.enabled ?? 0,
      lastRun: runs[0] ?? null, trend: trendOf(runs)
    }
  }))
}

export async function getSuiteDetail(suiteId: string, runLimit = 50): Promise<EvalSuiteDetail | null> {
  const db = useDb()
  const [s] = await db.select().from(evalSuites).where(eq(evalSuites.id, suiteId))
  if (!s) return null
  const rows = await db.select().from(evalCases).where(eq(evalCases.suiteId, suiteId)).orderBy(asc(evalCases.slug))
  const cases: EvalCaseListItem[] = rows.map(r => ({
    id: r.id, slug: r.slug, surface: r.surface as 'chat' | 'workstream', prompt: r.prompt, matchMode: r.matchMode as EvalMatchMode,
    holdout: r.holdout, enabled: r.enabled, nRuns: r.nRuns, hasRubric: !!r.rubric, updatedAt: r.updatedAt.toISOString()
  }))
  return {
    suite: { id: s.id, name: s.name, description: s.description, updatedAt: s.updatedAt.toISOString() },
    cases,
    runs: await listEvalRuns(suiteId, runLimit)
  }
}

export async function getCaseView(caseId: string): Promise<EvalCaseView | null> {
  const [r] = await useDb().select({ c: evalCases, suiteName: evalSuites.name }).from(evalCases)
    .innerJoin(evalSuites, eq(evalSuites.id, evalCases.suiteId)).where(eq(evalCases.id, caseId))
  if (!r) return null
  return { id: r.c.id, suiteId: r.c.suiteId, suiteName: r.suiteName, updatedAt: r.c.updatedAt.toISOString(), json: caseJsonOf(r.c) as Record<string, unknown> }
}

export function resultLite(r: EvalResultRow): EvalResultLite {
  const o = r.outcome as EvalAttemptOutcome | null
  return {
    id: r.id, caseId: r.caseId, attempt: r.attempt, score: r.score, passed: r.passed, error: r.error,
    failed: o?.scoring?.failed ?? null,
    forbidden: attemptHitForbidden(o?.scoring),
    verdict: o?.judge?.verdict ?? null, durationMs: r.durationMs, tokens: r.tokens
  }
}

export async function getRunView(runId: string): Promise<EvalRunView | null> {
  const db = useDb()
  const [row] = await db.select({ r: evalRuns, suiteName: evalSuites.name }).from(evalRuns)
    .innerJoin(evalSuites, eq(evalSuites.id, evalRuns.suiteId)).where(eq(evalRuns.id, runId))
  if (!row) return null
  const run = evalRunDTO(row.r)
  const results = await db.select().from(evalResults).where(eq(evalResults.runId, runId)).orderBy(evalResults.caseId, evalResults.attempt)
  // The cases: those it scored, those its summary lists, and (while it runs) those it was asked for.
  const ids = new Set<string>(results.map(r => r.caseId))
  for (const c of (run.summary as EvalRunSummary | null)?.cases ?? []) ids.add(c.caseId)
  const slugs = run.params.cases ?? []
  const caseRows = await db.select({ id: evalCases.id, slug: evalCases.slug, holdout: evalCases.holdout, surface: evalCases.surface, enabled: evalCases.enabled }).from(evalCases)
    .where(eq(evalCases.suiteId, run.suiteId))
  const planned = caseRows.filter(c => ids.has(c.id) || (run.status === 'queued' || run.status === 'running'
    ? (slugs.length ? slugs.includes(c.slug) : c.enabled)
    : false))
  return {
    run,
    suite: { id: run.suiteId, name: row.suiteName },
    cases: planned.sort((a, b) => a.slug.localeCompare(b.slug)).map(c => ({ id: c.id, slug: c.slug, holdout: c.holdout, surface: c.surface as 'chat' | 'workstream' })),
    results: results.map(resultLite)
  }
}

/** Fix round 1: with a snapshot, "edited" means the scoring inputs differ (a prompt or n_runs edit
 *  doesn't count); a result written before snapshots falls back to "updated after the run started". */
function editedSince(r: EvalResultRow, c: EvalCaseRow, runStartedAt: Date): boolean {
  const spec = (r.outcome as EvalAttemptOutcome | null)?.scoring?.spec
  return spec ? !sameScoringSpec(spec, scoringSpecOf(c)) : c.updatedAt.getTime() > runStartedAt.getTime()
}

export async function getAttemptView(resultId: string): Promise<EvalAttemptView | null> {
  const db = useDb()
  const [r] = await db.select().from(evalResults).where(eq(evalResults.id, resultId))
  if (!r) return null
  const [run] = await db.select({ r: evalRuns, suiteName: evalSuites.name }).from(evalRuns)
    .innerJoin(evalSuites, eq(evalSuites.id, evalRuns.suiteId)).where(eq(evalRuns.id, r.runId))
  if (!run) return null
  const [c] = await db.select().from(evalCases).where(eq(evalCases.id, r.caseId))
  return {
    result: evalResultDTO(r),
    run: evalRunDTO(run.r),
    suite: { id: run.r.suiteId, name: run.suiteName },
    case: c
      ? { id: c.id, slug: c.slug, updatedAt: c.updatedAt.toISOString(), editedSince: editedSince(r, c, run.r.startedAt), json: caseJsonOf(c) as Record<string, unknown> }
      : null
  }
}

/** Task 4 fix round 1: the Run dialog's model picker — every reasoning and subagents model (labels),
 *  and which one a run uses without an override (the reasoning head). */
export async function listEvalModels(): Promise<{ defaultId: string | null; models: Array<{ id: string; label: string; usage: 'reasoning' | 'subagents' }> }> {
  const [{ loadConfig }, { evalOverrideModelsFrom }] = await Promise.all([import('../ai/registry/store'), import('../ai/registry/resolve')])
  const models = evalOverrideModelsFrom(await loadConfig())
  return { defaultId: models.find(m => m.usage === 'reasoning')?.id ?? null, models }
}
