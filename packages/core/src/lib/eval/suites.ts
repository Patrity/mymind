// Cycle 85 (spec §3.1, D5): suites as JSON — the import/export format (and the seed suite's file
// format, Task 3). Field names follow the spec (snake_case). Import upserts the suite by name and
// each case by (suite, slug); `replace` also deletes the suite's cases the JSON no longer has.
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../db'
import { evalCases, evalSuites } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { EvalSetupSchema } from './setup'

export const MATCH_MODES = ['ordered_subset', 'exact', 'subset', 'contains_any'] as const

const regexString = z.string().refine((s) => {
  try { new RegExp(s, 'i'); return true } catch { return false }
}, { message: 'not a valid regular expression' })

export const EvalActionSpecSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  args_pattern: z.record(z.string(), regexString).optional()
})

export const EvalApprovalSpecSchema = z.object({ tool: z.string().min(1) })

export const EvalCaseJsonSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'lower-case letters, digits and dashes'),
  prompt: z.string().min(1),
  surface: z.enum(['chat', 'workstream']).default('chat'),
  setup: EvalSetupSchema.default({}),
  expected_actions: z.array(EvalActionSpecSchema).default([]),
  forbidden_actions: z.array(EvalActionSpecSchema).default([]),
  expected_content: z.array(regexString).default([]),
  match_mode: z.enum(MATCH_MODES).default('ordered_subset'),
  rubric: z.string().min(1).nullable().default(null),
  n_runs: z.number().int().min(1).max(20).default(3),
  max_steps: z.number().int().min(1).max(200).default(40),
  holdout: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Fix round 1 (S1): a matched call's result must carry a REAL output-guard flag (not the
   *  fail-closed `unverified`); and/or the run must end tainted. */
  expect_flagged: z.boolean().default(false),
  expect_tainted: z.boolean().default(false),
  /** Fix round 1 (S2): approval cards the scripted approver must / must not have been asked for. */
  expected_approvals: z.array(EvalApprovalSpecSchema).default([]),
  forbidden_approvals: z.array(EvalApprovalSpecSchema).default([]),
  /** Fix round 1 (M3): denied / errored calls satisfy expected actions only with this set. */
  count_failed: z.boolean().default(false)
})

export const EvalSuiteJsonSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  cases: z.array(EvalCaseJsonSchema)
}).superRefine((s, ctx) => {
  const seen = new Set<string>()
  s.cases.forEach((c, i) => {
    if (seen.has(c.slug)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'slug'], message: `duplicate slug "${c.slug}"` })
    seen.add(c.slug)
  })
})

export type EvalCaseJson = z.infer<typeof EvalCaseJsonSchema>

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
export type EvalSuiteJson = z.infer<typeof EvalSuiteJsonSchema>

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
    cases: rows.map(r => EvalCaseJsonSchema.parse({
      slug: r.slug, prompt: r.prompt, surface: r.surface, setup: r.setup,
      expected_actions: r.expectedActions, forbidden_actions: r.forbiddenActions, expected_content: r.expectedContent,
      match_mode: r.matchMode, rubric: r.rubric, n_runs: r.nRuns, max_steps: r.maxSteps, holdout: r.holdout, enabled: r.enabled,
      expect_flagged: r.expectFlagged, expect_tainted: r.expectTainted, expected_approvals: r.expectedApprovals,
      forbidden_approvals: r.forbiddenApprovals, count_failed: r.countFailed
    }))
  }
}
