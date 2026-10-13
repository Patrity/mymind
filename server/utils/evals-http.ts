// Cycle 85 Task 4: shared by the /api/evals routes — id validation, and turning the eval store's
// refusals (ZodError, EvalRunError, a duplicate slug) into 4xx errors the dashboard shows inline.
// h3 strips non-ASCII from statusMessage, so the readable text rides in `data.message`.
import { z, ZodError } from 'zod'
import type { H3Event } from 'h3'
import { EvalRunError } from '@mymind/core/lib/eval/runs'
import { EvalCaseConflictError } from '@mymind/core/lib/eval/suites'

/** A field-level problem the editor pins to its field: `path` as zod reports it. */
export interface EvalIssue { path: Array<string | number>, message: string }

export function requireEvalId(event: H3Event, what: string): string {
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: `No such ${what}`, data: { message: `No such ${what}.` } })
  }
  return id
}

export function notFound(what: string): Error {
  return createError({ statusCode: 404, statusMessage: `No such ${what}`, data: { message: `No such ${what}.` } })
}

export function issuesOf(err: ZodError): EvalIssue[] {
  return err.issues.map(i => ({ path: i.path.map(p => (typeof p === 'symbol' ? String(p) : p)), message: i.message }))
}

/** A known refusal as a 4xx; anything else is rethrown unchanged (a real 500). */
export function evalError(err: unknown): Error {
  if (err instanceof ZodError) {
    const issues = issuesOf(err)
    return createError({ statusCode: 400, statusMessage: 'Invalid', data: { code: 'invalid', message: issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), issues } })
  }
  if (err instanceof EvalCaseConflictError) return createError({ statusCode: 409, statusMessage: 'Conflict', data: { code: 'conflict', message: err.message } })
  if (err instanceof EvalRunError) return createError({ statusCode: 400, statusMessage: 'Refused', data: { code: 'refused', message: err.message } })
  return err instanceof Error ? err : new Error(String(err))
}
