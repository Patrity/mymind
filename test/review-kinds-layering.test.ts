// Cycle 80 Task 2: review-kind handlers live in server/lib/review/kinds.ts and throw a plain
// ReviewKindError (no h3/Nitro); server/api/review/kinds.ts wraps them so callers of the API
// module still get an H3 createError with the SAME statusCode/message/data as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReviewItem } from '../server/db/schema'

const reflect = vi.hoisted(() => ({
  apply: vi.fn(),
  reject: vi.fn()
}))
vi.mock('../server/lib/agent/reflect/apply', () => ({
  applyImprovement: reflect.apply,
  rejectImprovement: reflect.reject
}))
vi.mock('../server/db', () => ({ useDb: () => ({}) }))

// Nitro's auto-imported createError, stubbed exactly as test/reflect-apply.db.test.ts does.
const H3 = Symbol('h3')
vi.stubGlobal('createError', (o: { statusCode: number, message?: string, data?: unknown }) =>
  Object.assign(new Error(o.message ?? 'err'), o, { [H3]: true }))

// Static imports (after the hoisted mocks/stub): the module graph is large, and importing it
// inside a test body can exceed the 5s test timeout under a full parallel run.
import * as lib from '../server/lib/review/kinds'
import * as api from '../server/api/review/kinds'

const item = { id: 'rq-1', kind: 'self-improvement', targetId: 'imp-1', proposed: {} } as unknown as ReviewItem

async function caught(p: Promise<unknown>): Promise<Record<string | symbol, unknown>> {
  try {
    await p
  } catch (e) {
    return e as Record<string | symbol, unknown>
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  reflect.apply.mockReset()
  reflect.reject.mockReset()
})

describe('lib/review/kinds — plain errors', () => {
  it('already-decided reject throws a ReviewKindError (410), not an H3 error', async () => {
    const { rejectHandlers, ReviewKindError } = lib
    reflect.reject.mockResolvedValue(false)
    const err = await caught(rejectHandlers['self-improvement']!(item))
    expect(err).toBeInstanceOf(ReviewKindError)
    expect(err[H3]).toBeUndefined()
    expect(err).toMatchObject({ statusCode: 410, message: 'This improvement was already decided.', data: { summary: 'This improvement was already decided.' } })
  })

  it('apply failure throws a ReviewKindError (422) carrying the summary', async () => {
    const { approveHandlers, ReviewKindError } = lib
    reflect.apply.mockRejectedValue(new Error('target gone'))
    const err = await caught(approveHandlers['self-improvement']!(item))
    expect(err).toBeInstanceOf(ReviewKindError)
    expect(err).toMatchObject({ statusCode: 422, message: 'Could not apply: target gone', data: { summary: 'Could not apply: target gone' } })
  })
})

describe('api/review/kinds — HTTP wrapper', () => {
  it('maps the lib errors to createError with the same status/message/data as before', async () => {
    const { approveHandlers, rejectHandlers } = api
    reflect.reject.mockResolvedValue(false)
    const gone = await caught(rejectHandlers['self-improvement']!(item))
    expect(gone[H3]).toBe(true)
    expect(gone).toMatchObject({ statusCode: 410, message: 'This improvement was already decided.', data: { summary: 'This improvement was already decided.' } })

    reflect.apply.mockRejectedValue(new Error('target gone'))
    const unprocessable = await caught(approveHandlers['self-improvement']!(item))
    expect(unprocessable[H3]).toBe(true)
    expect(unprocessable).toMatchObject({ statusCode: 422, message: 'Could not apply: target gone', data: { summary: 'Could not apply: target gone' } })
  })

  it('passes non-ReviewKindError failures through untouched', async () => {
    const { rejectHandlers } = api
    const boom = new Error('db down')
    reflect.reject.mockRejectedValue(boom)
    expect(await caught(rejectHandlers['self-improvement']!(item))).toBe(boom)
  })
})
