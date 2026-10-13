// Cycle 85 (spec §3.3, D8): an eval run's lifecycle — the worker job `eval:run-suite`.
//
//   enqueueEvalRun (the web / `pnpm eval`)  → an eval_runs row 'queued' with its params, then the
//                                             `eval-run` worker command (fire-and-forget; the worker's
//                                             command poll picks it up if it was down).
//   startEvalRun (the worker's handler)     → claims the row (queued → running, owner = this boot) and
//                                             runs it in the background (runner.ts executeEvalRun);
//                                             returns at once (the bus handler contract).
//   cancelEvalRun                           → 'cancelled'; the runner sees it at its next heartbeat.
//   bootEval (worker boot)                  → a 'running' run whose heartbeat is stale died with a
//                                             crashed / restarted worker: it is marked 'failed' with
//                                             its partial results kept, THEN the world sweep drops its
//                                             tenants (cleanup.ts drops the worlds of finished runs);
//                                             then the built-in suites are seeded.
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalCases, evalResults, evalRuns, evalSuites, type EvalResultRow, type EvalRunRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { BOOT_ID } from '../agent/runtime/runs'
import type { EvalAttemptOutcome, EvalResultDTO, EvalRunDTO, EvalRunParams, EvalRunStatus, EvalRunSummary, EvalToolLogEntry } from '../../shared/types/eval'
import { EVAL_RUN_STALE_MS, executeEvalRun, summarizeStored, type EvalRunnerOptions } from './runner'

export class EvalRunError extends Error { override name = 'EvalRunError' }

/** Validates params against the suite (known slugs, n in 1..20, a reasoning model override). */
export async function normalizeParams(suiteId: string, p: EvalRunParams): Promise<EvalRunParams> {
  const out: EvalRunParams = {}
  if (p.cases?.length) {
    const slugs = [...new Set(p.cases.map(s => String(s).trim()).filter(Boolean))]
    const known = new Set((await useDb().select({ slug: evalCases.slug }).from(evalCases)
      .where(and(eq(evalCases.suiteId, suiteId), inArray(evalCases.slug, slugs)))).map(r => r.slug))
    const missing = slugs.filter(s => !known.has(s))
    if (missing.length) throw new EvalRunError(`unknown case(s): ${missing.join(', ')}`)
    out.cases = slugs
  }
  if (p.n !== undefined) {
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > 20) throw new EvalRunError('n must be a whole number from 1 to 20')
    out.n = p.n
  }
  if (p.model) {
    const { loadConfig } = await import('../ai/registry/store')
    const doc = await loadConfig()
    if (!(doc.assignments.reasoning ?? []).includes(p.model)) throw new EvalRunError(`model ${p.model} is not a reasoning model`)
    out.model = p.model
  }
  return out
}

export interface EnqueueEvalRunDeps { send?: (runId: string) => Promise<unknown> }

/** Creates a queued run and asks the worker to start it. Returns the run. */
export async function enqueueEvalRun(suiteId: string, params: EvalRunParams = {}, deps: EnqueueEvalRunDeps = {}): Promise<EvalRunRow> {
  const [suite] = await useDb().select({ id: evalSuites.id }).from(evalSuites).where(eq(evalSuites.id, suiteId))
  if (!suite) throw new EvalRunError('no such suite')
  const p = await normalizeParams(suiteId, params)
  const [row] = await useDb().insert(evalRuns).values({ suiteId, status: 'queued', params: p as Record<string, unknown> }).returning()
  publishChange({ resource: 'eval', action: 'created', id: row!.id })
  const send = deps.send ?? (async (runId: string) => {
    const { sendCommand } = await import('../bus/commands')
    return sendCommand('eval-run', { runId })
  })
  await send(row!.id).catch(err => console.error('[eval] sending eval-run failed (the worker poll retries it):', err))
  return row!
}

/** queued → running for THIS boot; null when the run is gone or not queued (already claimed). */
export async function claimEvalRun(runId: string): Promise<EvalRunRow | null> {
  const [row] = await useDb().update(evalRuns)
    .set({ status: 'running', owner: BOOT_ID, aliveAt: new Date(), startedAt: new Date() })
    .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, 'queued'))).returning()
  if (row) publishChange({ resource: 'eval', action: 'updated', id: runId })
  return row ?? null
}

const running = new Map<string, Promise<unknown>>()

/** The worker's `eval-run` handler: claim, then run in the background. */
export async function startEvalRun(runId: string, opts: EvalRunnerOptions = {}): Promise<{ started: boolean }> {
  const row = await claimEvalRun(runId)
  if (!row) return { started: false }
  const p = executeEvalRun(runId, opts).catch(err => console.error(`[eval] run ${runId} crashed:`, err)).finally(() => running.delete(runId))
  running.set(runId, p)
  return { started: true }
}

/** Eval runs executing in this process (tests; drain diagnostics). */
export function runningEvalRuns(): string[] { return [...running.keys()] }
export function _evalRunSettled(runId: string): Promise<unknown> { return running.get(runId) ?? Promise.resolve() }

/** Cancels a queued or running run; a running one stops at its next heartbeat (results kept). */
export async function cancelEvalRun(runId: string): Promise<boolean> {
  const rows = await useDb().update(evalRuns).set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(evalRuns.id, runId), inArray(evalRuns.status, ['queued', 'running']))).returning({ id: evalRuns.id })
  if (rows.length) publishChange({ resource: 'eval', action: 'updated', id: runId })
  return rows.length > 0
}

export const ORPHANED_RUN_ERROR = 'the worker stopped mid-run (a crash or a restart) — partial results kept'

/** Marks running runs whose heartbeat is stale (and not this boot's) failed, summaries rebuilt from
 *  the results they wrote. Returns their ids. */
export async function failOrphanedEvalRuns(o: { staleMs?: number } = {}): Promise<string[]> {
  const cutoff = new Date(Date.now() - (o.staleMs ?? EVAL_RUN_STALE_MS))
  const rows = await useDb().select({ id: evalRuns.id, startedAt: evalRuns.startedAt, aliveAt: evalRuns.aliveAt }).from(evalRuns)
    .where(and(eq(evalRuns.status, 'running'), or(isNull(evalRuns.owner), ne(evalRuns.owner, BOOT_ID)), or(isNull(evalRuns.aliveAt), lt(evalRuns.aliveAt, cutoff))))
  const out: string[] = []
  for (const r of rows) {
    const durationMs = Math.max(0, (r.aliveAt ?? r.startedAt).getTime() - r.startedAt.getTime())
    const prev = (await useDb().select({ summary: evalRuns.summary }).from(evalRuns).where(eq(evalRuns.id, r.id)))[0]?.summary as EvalRunSummary | null
    const summary = await summarizeStored(r.id, { durationMs, ...(prev?.planned !== undefined ? { planned: prev.planned } : {}), ...(prev?.promptHashes ? { promptHashes: prev.promptHashes } : {}) })
    const done = await useDb().update(evalRuns).set({ status: 'failed', error: ORPHANED_RUN_ERROR, finishedAt: new Date(), summary: summary as unknown as Record<string, unknown> })
      .where(and(eq(evalRuns.id, r.id), eq(evalRuns.status, 'running'), or(isNull(evalRuns.aliveAt), lt(evalRuns.aliveAt, cutoff)))).returning({ id: evalRuns.id })
    if (done.length) { out.push(r.id); publishChange({ resource: 'eval', action: 'updated', id: r.id }) }
  }
  return out
}

/** Worker boot: orphaned runs failed, then their worlds swept, then the built-in suites seeded.
 *  Never throws. */
export async function bootEval(o: { staleMs?: number; sweep?: () => Promise<unknown>; seed?: () => Promise<unknown> } = {}): Promise<{ failed: string[] }> {
  let failed: string[] = []
  try { failed = await failOrphanedEvalRuns(o) } catch (err) { console.warn('[eval] failing orphaned runs failed:', (err as Error).message) }
  try { await (o.sweep ?? (async () => (await import('./world')).bootSweepEval()))() } catch (err) { console.warn('[eval] boot sweep failed:', (err as Error).message) }
  try { await (o.seed ?? (async () => (await import('./suites')).seedBuiltinSuites()))() } catch (err) { console.warn('[eval] seeding built-in suites failed:', (err as Error).message) }
  if (failed.length) console.info(`[eval] marked ${failed.length} orphaned eval run(s) failed`)
  return { failed }
}

// ── DTOs (Task 4 renders these) ──────────────────────────────────────────────────────────────

export function evalRunDTO(r: EvalRunRow): EvalRunDTO {
  return {
    id: r.id, suiteId: r.suiteId, status: r.status as EvalRunStatus, gitSha: r.gitSha, modelLabel: r.modelLabel,
    promptHash: r.promptHash, toolsHash: r.toolsHash, params: (r.params ?? {}) as EvalRunParams,
    summary: (r.summary as EvalRunSummary | null) ?? null, error: r.error,
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null
  }
}

export function evalResultDTO(r: EvalResultRow): EvalResultDTO {
  return {
    id: r.id, runId: r.runId, caseId: r.caseId, attempt: r.attempt, score: r.score, passed: r.passed,
    toolLog: (r.toolLog ?? []) as EvalToolLogEntry[], finalText: r.finalText, outcome: (r.outcome as EvalAttemptOutcome | null) ?? null,
    capturedWrites: (r.capturedWrites ?? []) as EvalResultDTO['capturedWrites'], error: r.error, durationMs: r.durationMs, tokens: r.tokens,
    createdAt: r.createdAt.toISOString()
  }
}

export async function listEvalRuns(suiteId: string, limit = 50): Promise<EvalRunDTO[]> {
  const rows = await useDb().select().from(evalRuns).where(eq(evalRuns.suiteId, suiteId)).orderBy(desc(evalRuns.startedAt)).limit(limit)
  return rows.map(evalRunDTO)
}

export async function getEvalRun(runId: string): Promise<{ run: EvalRunDTO; results: EvalResultDTO[] } | null> {
  const [row] = await useDb().select().from(evalRuns).where(eq(evalRuns.id, runId))
  if (!row) return null
  const results = await useDb().select().from(evalResults).where(eq(evalResults.runId, runId)).orderBy(evalResults.caseId, evalResults.attempt)
  return { run: evalRunDTO(row), results: results.map(evalResultDTO) }
}

/** Results' count for a run (the CLI's progress line). */
export async function countEvalResults(runId: string): Promise<number> {
  const [r] = await useDb().select({ n: sql<number>`count(*)::int` }).from(evalResults).where(eq(evalResults.runId, runId))
  return r?.n ?? 0
}
