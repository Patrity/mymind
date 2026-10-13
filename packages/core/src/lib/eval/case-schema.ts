// Cycle 85 Task 4: the suite / case JSON schema on its own (zod only — no DB, no fs), so the /evals
// case editor validates in the browser with exactly the rules the server's import and save use.
import { z } from 'zod'
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

export type EvalSuiteJson = z.infer<typeof EvalSuiteJsonSchema>
