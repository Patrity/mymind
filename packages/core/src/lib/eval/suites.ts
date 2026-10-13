// Cycle 85 (spec §3.1, D5): suites as JSON — the import/export format (and the seed suite's file
// format, Task 3). Field names follow the spec (snake_case). Import upserts the suite by name and
// each case by (suite, slug); `replace` also deletes the suite's cases the JSON no longer has.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalCases, evalSuites, type EvalCaseRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { EvalCaseJsonSchema, EvalSuiteJsonSchema, type EvalCaseJson, type EvalSuiteJson } from './case-schema'
import { assertApprovalTools } from './approval-tools'

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
  await assertApprovalTools(suite.cases)
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

/** Final fix wave (SEED): a case definition's hash — stable key order, `enabled` left out (Tony's
 *  enable toggle is not an edit of the definition). */
export function caseDefinitionHash(c: EvalCaseJson): string {
  const { enabled: _enabled, ...def } = EvalCaseJsonSchema.parse(c)
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v
  return createHash('sha256').update(JSON.stringify(stable(def))).digest('hex')
}

/** Whether a stored case was edited away from the built-in definition it was seeded from. */
export function caseDiffersFromBuiltin(r: EvalCaseRow): boolean {
  return !!r.builtinHash && caseDefinitionHash(caseJsonOf(r)) !== r.builtinHash
}

export interface SeedResult { suiteId: string; added: number; updated: number; kept: number }

/**
 * Seeds a built-in suite (Task 3; final fix wave SEED): creates the suite when it is missing, inserts
 * each case whose slug it does not have yet, and UPDATES a case still exactly as it was seeded (its
 * definition hashes to its `builtin_hash` — or, for a row seeded before the hash existed, it was never
 * touched since its insert) when the file's definition changed — so a revised built-in reaches an
 * already-seeded DB. A case Tony edited is never overwritten: it is `kept`, and shows as differing
 * from the built-in. `enabled` is Tony's — except that a built-in case the file no longer has is
 * disabled while it is still exactly as seeded. Idempotent. A deleted built-in case comes back on the
 * next seed (disable it to retire it).
 */
export async function seedSuite(raw: unknown): Promise<SeedResult> {
  const suite = EvalSuiteJsonSchema.parse(raw)
  await assertApprovalTools(suite.cases)
  const r = await useDb().transaction(async (tx) => {
    await tx.insert(evalSuites).values({ name: suite.name, description: suite.description }).onConflictDoNothing({ target: evalSuites.name })
    const [s] = await tx.select({ id: evalSuites.id }).from(evalSuites).where(eq(evalSuites.name, suite.name))
    const suiteId = s!.id
    const rows = new Map((await tx.select().from(evalCases).where(eq(evalCases.suiteId, suiteId))).map(x => [x.slug, x]))
    let added = 0
    let updated = 0
    let kept = 0
    for (const c of suite.cases) {
      const fileHash = caseDefinitionHash(c)
      const row = rows.get(c.slug)
      if (!row) {
        const ins = await tx.insert(evalCases).values({ suiteId, slug: c.slug, ...caseValues(c), builtinHash: fileHash })
          .onConflictDoNothing({ target: [evalCases.suiteId, evalCases.slug] }).returning({ id: evalCases.id })
        added += ins.length
        continue
      }
      const rowHash = caseDefinitionHash(caseJsonOf(row))
      const unmodified = row.builtinHash ? rowHash === row.builtinHash : row.updatedAt.getTime() === row.createdAt.getTime()
      if (!unmodified) {
        // Edited by Tony: kept. A legacy row adopts the file's hash so it shows as differing from it.
        if (!row.builtinHash) await tx.update(evalCases).set({ builtinHash: fileHash }).where(eq(evalCases.id, row.id))
        kept++
        continue
      }
      if (rowHash === fileHash) {
        if (row.builtinHash !== fileHash) await tx.update(evalCases).set({ builtinHash: fileHash }).where(eq(evalCases.id, row.id))
        continue
      }
      const { enabled: _keepTonys, ...values } = caseValues(c)
      await tx.update(evalCases).set({ ...values, builtinHash: fileHash, updatedAt: new Date() }).where(eq(evalCases.id, row.id))
      updated++
    }
    // A built-in case the file no longer has (renamed or replaced): disable it — only while it is still
    // exactly as seeded, so a case Tony edited (or one that was never built-in) is left alone.
    const fileSlugs = new Set(suite.cases.map(c => c.slug))
    for (const row of rows.values()) {
      if (fileSlugs.has(row.slug) || !row.builtinHash || !row.enabled) continue
      if (caseDefinitionHash(caseJsonOf(row)) !== row.builtinHash) continue
      await tx.update(evalCases).set({ enabled: false, updatedAt: new Date() }).where(eq(evalCases.id, row.id))
      updated++
    }
    return { suiteId, added, updated, kept }
  })
  if (r.added || r.updated) publishChange({ resource: 'eval', action: 'updated', id: r.suiteId })
  return r
}

/** Where the built-in suites live (`evals/*.json` at the app root — the worker's cwd in prod). */
export function builtinSuitesDir(): string {
  return resolve(process.env.MYMIND_EVALS_DIR ?? join(process.cwd(), 'evals'))
}

/** Seeds every built-in suite (`evals/*.json`). Never throws: a bad file is reported and skipped. */
export async function seedBuiltinSuites(dir = builtinSuitesDir()): Promise<Array<{ file: string; error?: string } & Partial<SeedResult>>> {
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort() } catch { return [] }
  const out: Array<{ file: string; error?: string } & Partial<SeedResult>> = []
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
  await assertApprovalTools([c], [])
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
