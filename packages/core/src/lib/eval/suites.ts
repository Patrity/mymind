// Cycle 85 (spec §3.1, D5): suites as JSON — the import/export format (and the seed suite's file
// format, Task 3). Field names follow the spec (snake_case). Import upserts the suite by name and
// each case by (suite, slug); `replace` also deletes the suite's cases the JSON no longer has.
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../db'
import { evalCases, evalSuites } from '../../db/schema'
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
  enabled: z.boolean().default(true)
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
export type EvalSuiteJson = z.infer<typeof EvalSuiteJsonSchema>

export interface ImportResult { suiteId: string; created: number; updated: number; removed: number }

/** Validates and upserts a suite. Throws a ZodError on invalid JSON (nothing is written). */
export async function importSuite(raw: unknown, opts: { replace?: boolean } = {}): Promise<ImportResult> {
  const suite = EvalSuiteJsonSchema.parse(raw)
  return useDb().transaction(async (tx) => {
    const now = new Date()
    const [s] = await tx.insert(evalSuites).values({ name: suite.name, description: suite.description })
      .onConflictDoUpdate({ target: evalSuites.name, set: { description: suite.description, updatedAt: now } })
      .returning({ id: evalSuites.id })
    const suiteId = s!.id
    const existing = new Set((await tx.select({ slug: evalCases.slug }).from(evalCases).where(eq(evalCases.suiteId, suiteId))).map(r => r.slug))
    let created = 0
    let updated = 0
    for (const c of suite.cases) {
      const values = {
        prompt: c.prompt, surface: c.surface, setup: c.setup as Record<string, unknown>,
        expectedActions: c.expected_actions, forbiddenActions: c.forbidden_actions, expectedContent: c.expected_content,
        matchMode: c.match_mode, rubric: c.rubric, nRuns: c.n_runs, maxSteps: c.max_steps, holdout: c.holdout, enabled: c.enabled,
        updatedAt: now
      }
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
      match_mode: r.matchMode, rubric: r.rubric, n_runs: r.nRuns, max_steps: r.maxSteps, holdout: r.holdout, enabled: r.enabled
    }))
  }
}
