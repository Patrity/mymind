// Cycle 85 final fix wave (Task 3 N3): a case's `expected_approvals` / `forbidden_approvals` must name a
// tool that can raise an approval card — a `dangerous` tool (always asks) or an `outbound` one (asks in
// a tainted run). Any other name never matches a card: a typo in `forbidden_approvals` would silently
// never fire (and `send_message` in the seed suite read as a guarantee it did not give — N1). Checked
// on import, seed and save against the workstream profile's registry (Bridget's tools plus the
// workstream-only ones).
import { z } from 'zod'
import type { EvalCaseJson } from './case-schema'

/** Tool names that can raise an approval card. */
export async function approvalCapableTools(): Promise<Set<string>> {
  const { workstreamProfile, bridgetProfile } = await import('../agent/profile')
  const tools = [...bridgetProfile.tools, ...workstreamProfile.tools]
  return new Set(tools.filter(t => t.dangerous || t.outbound || t.outboundWhen).map(t => t.name))
}

/** Throws a ZodError (a 400 on the routes) naming every approval spec whose tool can never raise a card. */
export async function assertApprovalTools(cases: Array<Pick<EvalCaseJson, 'expected_approvals' | 'forbidden_approvals'>>, pathPrefix: Array<string | number> = ['cases']): Promise<void> {
  const ok = await approvalCapableTools()
  const issues: z.core.$ZodIssue[] = []
  cases.forEach((c, i) => {
    for (const key of ['expected_approvals', 'forbidden_approvals'] as const) {
      (c[key] ?? []).forEach((a, j) => {
        if (!ok.has(a.tool)) {
          issues.push({ code: 'custom', input: a.tool, path: [...pathPrefix, ...(pathPrefix.length ? [i] : []), key, j, 'tool'], message: `"${a.tool}" never raises an approval card — only dangerous or outbound tools do (e.g. ${[...ok].slice(0, 4).join(', ')})` } as z.core.$ZodIssue)
        }
      })
    }
  })
  if (issues.length) throw new z.ZodError(issues)
}
