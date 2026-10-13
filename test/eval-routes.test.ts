// Cycle 85 Task 4: the /api/evals routes. Reads take a session OR a token (the shared middleware);
// every write (run, import, case save, enable toggle, cancel) is session-only — a leaked machine
// token must not spend model calls or change what Bridget is measured against. The store is mocked;
// requireSession and the error mapping are the real code.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])

class EvalRunError extends Error { override name = 'EvalRunError' }
class EvalCaseConflictError extends Error { override name = 'EvalCaseConflictError' }
const enqueueEvalRun = vi.fn()
const cancelEvalRun = vi.fn()
const importSuite = vi.fn()
const updateCase = vi.fn()
const setCaseEnabled = vi.fn()
const exportSuite = vi.fn()
const getCaseView = vi.fn()
const getRunView = vi.fn()
const getAttemptView = vi.fn()
const getSuiteDetail = vi.fn()
const listSuiteOverviews = vi.fn()
vi.mock('@mymind/core/lib/eval/runs', () => ({ EvalRunError, enqueueEvalRun, cancelEvalRun, evalRunDTO: (r: unknown) => ({ dto: r }) }))
vi.mock('@mymind/core/lib/eval/suites', () => ({ EvalCaseConflictError, importSuite, updateCase, setCaseEnabled, exportSuite }))
vi.mock('@mymind/core/lib/eval/dashboard', () => ({ getCaseView, getRunView, getAttemptView, getSuiteDetail, listSuiteOverviews }))

type H = (e: unknown) => Promise<unknown>
const load = async (p: string) => (await import(p)).default as H
const runsPost = await load('../server/api/evals/suites/[id]/runs.post')
const importPost = await load('../server/api/evals/suites/import.post')
const casePut = await load('../server/api/evals/cases/[id].put')
const casePatch = await load('../server/api/evals/cases/[id].patch')
const cancelPost = await load('../server/api/evals/runs/[id]/cancel.post')
const runGet = await load('../server/api/evals/runs/[id].get')
const attemptGet = await load('../server/api/evals/results/[id].get')
const suitesGet = await load('../server/api/evals/suites/index.get')
const suiteGet = await load('../server/api/evals/suites/[id]/index.get')
const exportGet = await load('../server/api/evals/suites/[id]/export.get')
const caseGet = await load('../server/api/evals/cases/[id].get')

const ID = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'
const SESSION = { type: 'session', userId: 'u1' }
const TOKEN = { type: 'api-token', tokenId: 't1' }
const evt = (client: unknown, body: unknown = {}, id: string = ID) => ({ context: { client }, body, params: { id } })

beforeEach(() => { vi.clearAllMocks() })

describe('writes are session-only', () => {
  const writes: Array<[string, H, () => unknown, unknown]> = [
    ['run a suite', runsPost, () => enqueueEvalRun, {}],
    ['import', importPost, () => importSuite, { suite: {} }],
    ['save a case', casePut, () => updateCase, { slug: 'x' }],
    ['enable toggle', casePatch, () => setCaseEnabled, { enabled: false }],
    ['cancel a run', cancelPost, () => cancelEvalRun, {}]
  ]
  for (const [name, h, fn, body] of writes) {
    it(`${name}: a token is 403 and nothing is written`, async () => {
      await expect(h(evt(TOKEN, body))).rejects.toMatchObject({ statusCode: 403 })
      await expect(h(evt(undefined, body))).rejects.toMatchObject({ statusCode: 403 })
      expect(fn()).not.toHaveBeenCalled()
    })
  }

  it('a session runs a suite with the parsed params', async () => {
    enqueueEvalRun.mockResolvedValue({ id: 'r1' })
    const out = await runsPost(evt(SESSION, { cases: ['a', 'b'], n: 1 }))
    expect(enqueueEvalRun).toHaveBeenCalledWith(ID, { cases: ['a', 'b'], n: 1 })
    expect(out).toEqual({ dto: { id: 'r1' } })
  })

  it('a session saves a case and toggles one', async () => {
    updateCase.mockResolvedValue({ id: ID })
    getCaseView.mockResolvedValue({ id: ID, json: {} })
    await expect(casePut(evt(SESSION, { slug: 'x' }))).resolves.toEqual({ id: ID, json: {} })
    setCaseEnabled.mockResolvedValue({ id: ID, enabled: false })
    await expect(casePatch(evt(SESSION, { enabled: false }))).resolves.toEqual({ id: ID, enabled: false })
    expect(setCaseEnabled).toHaveBeenCalledWith(ID, false)
  })

  it('a session imports with replace only when it is literally true', async () => {
    importSuite.mockResolvedValue({ suiteId: ID })
    await importPost(evt(SESSION, { suite: { name: 's' }, replace: 'yes' }))
    expect(importSuite).toHaveBeenLastCalledWith({ name: 's' }, { replace: false })
    await importPost(evt(SESSION, { suite: { name: 's' }, replace: true }))
    expect(importSuite).toHaveBeenLastCalledWith({ name: 's' }, { replace: true })
  })
})

describe('reads take a token too', () => {
  it('every read answers an api-token client', async () => {
    listSuiteOverviews.mockResolvedValue([])
    getSuiteDetail.mockResolvedValue({ suite: {} })
    getRunView.mockResolvedValue({ run: {} })
    getAttemptView.mockResolvedValue({ result: {} })
    exportSuite.mockResolvedValue({ name: 's' })
    getCaseView.mockResolvedValue({ id: ID })
    for (const h of [suitesGet, suiteGet, runGet, attemptGet, exportGet, caseGet]) await expect(h(evt(TOKEN))).resolves.toBeTruthy()
  })

  it('a missing row is 404, a malformed id is 404 without touching the store', async () => {
    getRunView.mockResolvedValue(null)
    await expect(runGet(evt(TOKEN))).rejects.toMatchObject({ statusCode: 404 })
    await expect(attemptGet(evt(TOKEN, {}, 'nope'))).rejects.toMatchObject({ statusCode: 404 })
    expect(getAttemptView).not.toHaveBeenCalled()
  })
})

describe('refusals become 4xx the editor can show', () => {
  it('a ZodError on save is a 400 carrying each issue by path', async () => {
    const zerr = z.object({ n_runs: z.number().max(20) }).safeParse({ n_runs: 99 }).error!
    updateCase.mockRejectedValue(zerr)
    await expect(casePut(evt(SESSION, { n_runs: 99 }))).rejects.toMatchObject({
      statusCode: 400,
      data: { code: 'invalid', issues: [{ path: ['n_runs'], message: expect.stringMatching(/20/) }] }
    })
  })

  it('a duplicate slug is 409; a refused run is 400; an unknown error propagates unchanged', async () => {
    updateCase.mockRejectedValue(new EvalCaseConflictError('another case … "x"'))
    await expect(casePut(evt(SESSION, {}))).rejects.toMatchObject({ statusCode: 409, data: { code: 'conflict' } })
    enqueueEvalRun.mockRejectedValue(new EvalRunError('unknown case(s): zz'))
    await expect(runsPost(evt(SESSION, { cases: ['zz'] }))).rejects.toMatchObject({ statusCode: 400, data: { message: 'unknown case(s): zz' } })
    const boom = new Error('db down')
    enqueueEvalRun.mockRejectedValue(boom)
    await expect(runsPost(evt(SESSION, {}))).rejects.toBe(boom)
  })

  it('run params of the wrong type are a 400 before anything is enqueued', async () => {
    await expect(runsPost(evt(SESSION, { cases: 'task-create' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(runsPost(evt(SESSION, { n: 1.5 }))).rejects.toMatchObject({ statusCode: 400 })
    expect(enqueueEvalRun).not.toHaveBeenCalled()
  })

  it('the enable toggle refuses a non-boolean; a gone case is 404', async () => {
    await expect(casePatch(evt(SESSION, { enabled: 'no' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(setCaseEnabled).not.toHaveBeenCalled()
    setCaseEnabled.mockResolvedValue(null)
    await expect(casePatch(evt(SESSION, { enabled: true }))).rejects.toMatchObject({ statusCode: 404 })
  })
})
