// Cycle 85 (spec §3.1, D5): suites as JSON — the import/export format (and the seed suite's file
// format, Task 3). Field names follow the spec (snake_case). Import upserts the suite by name and
// each case by (suite, slug); `replace` also deletes the suite's cases the JSON no longer has.
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalCases, evalSuites, type EvalCaseRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { EvalCaseJsonSchema, EvalSuiteJsonSchema, type EvalCaseJson, type EvalSuiteJson } from './case-schema'

export { MATCH_MODES, EvalActionSpecSchema, EvalApprovalSpecSchema, EvalCaseJsonSchema, EvalSuiteJsonSchema, type EvalCaseJson, type EvalSuiteJson } from './case-schema'

/** A parsed case's column values (everything but suite and slug). */
export function caseValues(c: EvalCaseJson) {
  return {
    prompt: c.prompt, surface: c.surface, setup: c.setup as Record<string, unknown>,
    expectedActions: c.expected_actions, forbiddenActions: c.forbidden_actions, expectedContent: c.expected_content,
    matchMode: c.match_mode, rubric: c.rubric, nRuns: c.n_runs, maxSteps: c.max_steps, holdout: c.holdout, enabled: c.enabled,
    expectFlagged: c.expect_flagged, expectTainted: c.expect_tainted, expectedApprovals: c.expected_approvals,
    forbiddenApprovals: c.forbidden_approvals, countFailed: c.count_failed
  }
}

export interface ImportResult { suiteId: string; created: number; updated: number; removed: number }

/** Validates and upserts a suite. Throws a ZodError on invalid JSON (nothing is written). */
export async function importSuite(raw: unknown, opts: { replace?: boolean } = {}): Promise<ImportResult> {
  const suite = EvalSuiteJsonSchema.parse(raw)
  const r = await useDb().transaction(async (tx) => {
    const now = new Date()
    const [s] = await tx.insert(evalSuites).values({ name: suite.name, description: suite.description })
      .onConflictDoUpdate({ target: evalSuites.name, set: { description: suite.description, updatedAt: now } })
      .returning({ id: evalSuites.id })
    const suiteId = s!.id
    const existing = new Set((await tx.select({ slug: evalCases.slug }).from(evalCases).where(eq(evalCases.suiteId, suiteId))).map(r => r.slug))
    let created = 0
    let updated = 0
    for (const c of suite.cases) {
      const values = { ...caseValues(c), updatedAt: now }
      await tx.insert(evalCases).values({ suiteId, slug: c.slug, ...values })
        .onConflictDoUpdate({ target: [evalCases.suiteId, evalCases.slug], set: values })
      if (existing.has(c.slug)) updated++
      else created++
    }
    let removed = 0
    if (opts.replace) {
      const keep = suite.cases.map(c => c.slug)
      const gone = await tx.delete(evalCases)
        .where(and(eq(evalCases.suiteId, suiteId), keep.length ? notInArray(evalCases.slug, keep) : undefined))
        .returning({ id: evalCases.id })
      removed = gone.length
    }
    return { suiteId, created, updated, removed }
  })
  // Task 3 (live-data rule): after the commit — the /evals pages refetch.
  publishChange({ resource: 'eval', action: r.created && !r.updated ? 'created' : 'updated', id: r.suiteId })
  return r
}

/**
 * Seeds a built-in suite (Task 3): creates the suite when it is missing and inserts each case whose
 * slug it does not have yet — idempotent, and it never overwrites a case Tony edited in the UI. A
 * deleted built-in case comes back on the next seed: retire one by disabling it. Returns the suite id
 * and how many cases were added.
 */
export async function seedSuite(raw: unknown): Promise<{ suiteId: string; added: number }> {
  const suite = EvalSuiteJsonSchema.parse(raw)
  const r = await useDb().transaction(async (tx) => {
    await tx.insert(evalSuites).values({ name: suite.name, description: suite.description }).onConflictDoNothing({ target: evalSuites.name })
    const [s] = await tx.select({ id: evalSuites.id }).from(evalSuites).where(eq(evalSuites.name, suite.name))
    const suiteId = s!.id
    let added = 0
    for (const c of suite.cases) {
      const rows = await tx.insert(evalCases).values({ suiteId, slug: c.slug, ...caseValues(c) }).onConflictDoNothing({ target: [evalCases.suiteId, evalCases.slug] }).returning({ id: evalCases.id })
      added += rows.length
    }
    return { suiteId, added }
  })
  if (r.added) publishChange({ resource: 'eval', action: 'updated', id: r.suiteId })
  return r
}

/** Where the built-in suites live (`evals/*.json` at the app root — the worker's cwd in prod). */
export function builtinSuitesDir(): string {
  return resolve(process.env.MYMIND_EVALS_DIR ?? join(process.cwd(), 'evals'))
}

/** Seeds every built-in suite (`evals/*.json`). Never throws: a bad file is reported and skipped. */
export async function seedBuiltinSuites(dir = builtinSuitesDir()): Promise<Array<{ file: string; suiteId?: string; added?: number; error?: string }>> {
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort() } catch { return [] }
  const out: Array<{ file: string; suiteId?: string; added?: number; error?: string }> = []
  for (const file of files) {
    try {
      out.push({ file, ...await seedSuite(JSON.parse(await readFile(join(dir, file), 'utf8'))) })
    } catch (err) {
      const error = (err as Error).message.slice(0, 300)
      console.warn(`[eval] seeding ${file} failed: ${error}`)
      out.push({ file, error })
    }
  }
  return out
}

/** The suite as import-ready JSON (cases by slug), or null when it does not exist. */
export async function exportSuite(suiteId: string): Promise<EvalSuiteJson | null> {
  const db = useDb()
  const [s] = await db.select().from(evalSuites).where(eq(evalSuites.id, suiteId))
  if (!s) return null
  const rows = await db.select().from(evalCases).where(eq(evalCases.suiteId, suiteId)).orderBy(asc(evalCases.slug))
  return {
    version: 1,
    name: s.name,
    description: s.description,
    cases: rows.map(caseJsonOf)
  }
}

/** A stored case as its JSON (the export / editor form). */
export function caseJsonOf(r: EvalCaseRow): EvalCaseJson {
  return EvalCaseJsonSchema.parse({
    slug: r.slug, prompt: r.prompt, surface: r.surface, setup: r.setup,
    expected_actions: r.expectedActions, forbidden_actions: r.forbiddenActions, expected_content: r.expectedContent,
    match_mode: r.matchMode, rubric: r.rubric, n_runs: r.nRuns, max_steps: r.maxSteps, holdout: r.holdout, enabled: r.enabled,
    expect_flagged: r.expectFlagged, expect_tainted: r.expectTainted, expected_approvals: r.expectedApprovals,
    forbidden_approvals: r.forbiddenApprovals, count_failed: r.countFailed
  })
}

/** Task 4: a case save the store refused for a reason the editor can show (a slug another case of the
 *  suite already has). Validation failures are ZodErrors. */
export class EvalCaseConflictError extends Error { override name = 'EvalCaseConflictError' }

/** Task 4 (the /evals case editor): replaces a case with validated JSON. Throws a ZodError on invalid
 *  JSON (nothing written) and EvalCaseConflictError on a duplicate slug; null when the case is gone. */
export async function updateCase(caseId: string, raw: unknown): Promise<EvalCaseRow | null> {
  const c = EvalCaseJsonSchema.parse(raw)
  try {
    const [row] = await useDb().update(evalCases).set({ slug: c.slug, ...caseValues(c), updatedAt: new Date() })
      .where(eq(evalCases.id, caseId)).returning()
    if (!row) return null
    publishChange({ resource: 'eval', action: 'updated', id: caseId })
    return row
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new EvalCaseConflictError(`another case in this suite is already called "${c.slug}"`)
    }
    throw err
  }
}

/** Task 4: the enable toggle. Null when the case is gone. */
export async function setCaseEnabled(caseId: string, enabled: boolean): Promise<EvalCaseRow | null> {
  const [row] = await useDb().update(evalCases).set({ enabled, updatedAt: new Date() }).where(eq(evalCases.id, caseId)).returning()
  if (!row) return null
  publishChange({ resource: 'eval', action: 'updated', id: caseId })
  return row
}
