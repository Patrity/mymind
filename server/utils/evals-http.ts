// Cycle 85 Task 4: shared by the /api/evals routes — id validation, and turning the eval store's
// refusals (ZodError, EvalRunError, a duplicate slug) into 4xx errors the dashboard shows inline.
// h3 strips non-ASCII from statusMessage, so the readable text rides in `data.message`.
import { z, ZodError } from 'zod'
import type { H3Event } from 'h3'
import { EvalRunConflictError, EvalRunError } from '@mymind/core/lib/eval/runs'
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

/** Task 4 fix round 1: request-size caps for the eval write routes. */
export const IMPORT_BODY_MAX = 2 * 1024 * 1024
export const CASE_BODY_MAX = 2 * 1024 * 1024
export const SMALL_BODY_MAX = 64 * 1024

/**
 * Reads a JSON body of at most `maxBytes`: a declared Content-Length over it is refused (413) before
 * the body is read; an actual body over it (chunked, or a lying header) is refused AS IT STREAMS — the
 * read stops at the first chunk past the cap, so an oversized body is never buffered whole (cycle 85
 * final fix wave). Malformed JSON is a 400 — never a 500. An empty body reads as `{}`.
 */
export async function readJsonBody(event: H3Event, maxBytes: number): Promise<unknown> {
  const tooLarge = () => createError({ statusCode: 413, statusMessage: 'Payload Too Large', data: { code: 'too-large', message: `The request is larger than ${Math.round(maxBytes / 1024)} KB.` } })
  const declared = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
  const raw = await readCapped(event, maxBytes, tooLarge)
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON', data: { code: 'invalid-json', message: `Not valid JSON: ${(e as Error).message}` } })
  }
}

/** The body as UTF-8, read chunk by chunk; past `maxBytes` the stream is cancelled and `tooLarge()`
 *  thrown. */
async function readCapped(event: H3Event, maxBytes: number, tooLarge: () => Error): Promise<string> {
  const stream = getRequestWebStream(event)
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : value as Uint8Array
    size += chunk.byteLength
    if (size > maxBytes) {
      await reader.cancel('payload too large').catch(() => {})
      throw tooLarge()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
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
  if (err instanceof EvalRunConflictError) return createError({ statusCode: 409, statusMessage: 'Conflict', data: { code: 'run-active', message: err.message, runId: err.runId } })
  if (err instanceof EvalRunError) return createError({ statusCode: 400, statusMessage: 'Refused', data: { code: 'refused', message: err.message } })
  return err instanceof Error ? err : new Error(String(err))
}
