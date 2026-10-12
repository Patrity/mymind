// Cycle 84 Task 1 — the `judge` AI usage: through the stored-doc schema and the Settings PUT/GET,
// the client's usage list, and the judge chain resolution (empty → reasoning).
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

let stored: unknown = null
const saveConfig = vi.fn(async (doc: unknown) => { stored = doc })
vi.mock('@mymind/core/lib/ai/registry/store', async () => {
  const { parseConfig } = await import('@mymind/core/lib/ai/registry/schema')
  const { emptyDoc } = await import('@mymind/core/lib/ai/registry/types')
  return {
    loadConfig: async () => (stored ? parseConfig(stored) : emptyDoc()),
    saveConfig: (d: unknown) => saveConfig(d),
    invalidate: () => {}
  }
})
vi.mock('@mymind/core/lib/bus/invalidate', () => ({ invalidateWorkerCache: async () => {} }))

const { parseConfig } = await import('@mymind/core/lib/ai/registry/schema')
const { emptyDoc, USAGES } = await import('@mymind/core/lib/ai/registry/types')
const { resolveJudgeChainFrom, resolveJudgeChain } = await import('@mymind/core/lib/ai/registry/resolve')
const { AiNotConfiguredError } = await import('@mymind/core/lib/ai/registry/errors')
type H = (e: unknown) => Promise<unknown>
const put = (await import('../server/api/settings/ai-config.put')).default as H
const get = (await import('../server/api/settings/ai-config.get')).default as H

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })
beforeEach(() => { stored = null; saveConfig.mockClear() })

type M = { id: string; label: string; dim?: number | null }
function doc(models: M[], assignments: Partial<Record<string, string[]>>) {
  return {
    version: 1 as const,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible' as const, baseURL: 'http://x/v1', apiKeyEnc: null }],
    models: models.map(m => ({ providerId: 'p1', modelId: m.id, dim: null, contextWindow: null, description: null, maxInFlight: null, ...m })),
    assignments: { ...emptyDoc().assignments, ...assignments }
  }
}
const MODELS: M[] = [{ id: 'r1', label: 'R1' }, { id: 'r2', label: 'R2' }, { id: 'j1', label: 'J1' }, { id: 'j2', label: 'J2' }, { id: 'e1', label: 'Embed', dim: 2560 }]

describe('judge usage (stored doc + client)', () => {
  it('judge is a usage, and a config stored before it existed parses with it empty', () => {
    expect(USAGES).toContain('judge')
    expect(emptyDoc().assignments.judge).toEqual([])
    const older = doc(MODELS, { reasoning: ['r1'] }) as { assignments: Record<string, unknown> }
    delete older.assignments.judge
    expect(parseConfig(older).assignments.judge).toEqual([])
  })

  it('the client usage list (Settings → AI assignments) carries judge, in step with the server', () => {
    const src = readFileSync('app/composables/useAiConfig.ts', 'utf8')
    const list = src.match(/const USAGES = \[([^\]]+)\] as const/)![1]!
    expect(list.split(',').map(s => s.trim().replace(/'/g, ''))).toEqual([...USAGES])
  })
})

describe('resolveJudgeChainFrom', () => {
  it('empty judge → the reasoning chain', () => {
    expect(resolveJudgeChainFrom(parseConfig(doc(MODELS, { reasoning: ['r1', 'r2'] }))).map(m => m.label)).toEqual(['R1', 'R2'])
  })

  it('judge models, in order, with failover between them — reasoning not appended', () => {
    const chain = resolveJudgeChainFrom(parseConfig(doc(MODELS, { reasoning: ['r1'], judge: ['j2', 'j1'] })))
    expect(chain.map(m => m.label)).toEqual(['J2', 'J1'])
    expect(chain.every(m => m.usage === 'judge')).toBe(true)
  })

  it('an embedding model in judge is skipped; judge with only one falls back to reasoning', () => {
    expect(resolveJudgeChainFrom(parseConfig(doc(MODELS, { reasoning: ['r1'], judge: ['e1', 'j1'] }))).map(m => m.label)).toEqual(['J1'])
    expect(resolveJudgeChainFrom(parseConfig(doc(MODELS, { reasoning: ['r1'], judge: ['e1'] }))).map(m => m.label)).toEqual(['R1'])
  })

  it('nothing at all → AiNotConfiguredError', () => {
    expect(() => resolveJudgeChainFrom(parseConfig(doc(MODELS, {})))).toThrow(AiNotConfiguredError)
  })

  it('the cached resolver reads the stored config', async () => {
    stored = doc(MODELS, { reasoning: ['r1'], judge: ['j1'] })
    expect((await resolveJudgeChain()).map(m => m.label)).toEqual(['J1'])
  })
})

describe('Settings PUT/GET with judge', () => {
  const body = () => ({
    version: 1,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible', baseURL: 'http://x/v1', key: null }],
    models: MODELS.map(m => ({ providerId: 'p1', modelId: m.id, dim: null, contextWindow: null, description: null, maxInFlight: null, ...m })),
    assignments: { reasoning: ['r1'], judge: ['j1', 'j2'] } as Record<string, string[]>
  })

  it('a judge chain survives the save and comes back on read', async () => {
    await put({ body: body() })
    expect(saveConfig).toHaveBeenCalledOnce()
    const back = await get({}) as { assignments: Record<string, string[]> }
    expect(back.assignments.judge).toEqual(['j1', 'j2'])
  })

  it('an embedding model in judge is a 422 naming it; nothing is saved', async () => {
    const b = body(); b.assignments.judge = ['j1', 'e1']
    await expect(put({ body: b })).rejects.toMatchObject({ statusCode: 422, data: expect.stringContaining('"Embed" is an embedding model and cannot be a judge model') })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('an older client that does not send judge still saves (judge empty)', async () => {
    const b = body(); delete b.assignments.judge
    await put({ body: b })
    expect(parseConfig(stored).assignments.judge).toEqual([])
  })
})
