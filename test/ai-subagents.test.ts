// Cycle 83 Task 1 — the `subagents` model class: ModelDef description + maxInFlight, the
// subagents usage through the stored-doc schema and the Settings PUT/GET, the child-model
// resolution order, and the pool sizes the claim path reads.
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

const { parseConfig, redactDoc } = await import('@mymind/core/lib/ai/registry/schema')
const { emptyDoc, DEFAULT_MAX_IN_FLIGHT, MAX_IN_FLIGHT_LIMITS, USAGES } = await import('@mymind/core/lib/ai/registry/types')
const { resolveSubagentChainFrom, listSubagentModelsFrom, resolveSubagentModel, listSubagentModels } = await import('@mymind/core/lib/ai/registry/resolve')
const { AiNotConfiguredError, UnknownSubagentModelError } = await import('@mymind/core/lib/ai/registry/errors')
const { poolLimitsFrom } = await import('@mymind/core/lib/agent/runtime/pools')
const clientConsts = await import('../app/utils/ai-config')
type H = (e: unknown) => Promise<unknown>
const put = (await import('../server/api/settings/ai-config.put')).default as H
const get = (await import('../server/api/settings/ai-config.get')).default as H

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })
beforeEach(() => { stored = null; saveConfig.mockClear() })

type M = { id: string; label: string; description?: string | null; maxInFlight?: number | null }
function doc(models: M[], assignments: Partial<Record<string, string[]>>) {
  return {
    version: 1 as const,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible' as const, baseURL: 'http://x/v1', apiKeyEnc: null }],
    models: models.map(m => ({ providerId: 'p1', modelId: m.id, dim: null, contextWindow: null, description: null, maxInFlight: null, ...m })),
    assignments: { ...emptyDoc().assignments, ...assignments }
  }
}
const FOUR: M[] = [{ id: 'r1', label: 'R1' }, { id: 'r2', label: 'R2' }, { id: 's1', label: 'Fast' }, { id: 's2', label: 'Deep' }]

describe('subagents usage + ModelDef description/maxInFlight (stored doc)', () => {
  it('subagents is a usage, and a config stored before it existed parses with it empty', () => {
    expect(USAGES).toContain('subagents')
    const older = doc(FOUR, { reasoning: ['r1'] }) as { assignments: Record<string, unknown> }
    delete older.assignments.subagents
    expect(parseConfig(older).assignments.subagents).toEqual([])
  })

  it('a model stored before description/maxInFlight existed parses with both null', () => {
    const d = doc(FOUR, {})
    for (const m of d.models as Array<Record<string, unknown>>) { delete m.description; delete m.maxInFlight }
    const parsed = parseConfig(d)
    expect(parsed.models[0]!.description).toBeNull()
    expect(parsed.models[0]!.maxInFlight).toBeNull()
  })

  it('maxInFlight accepts 1–256 integers and rejects everything else', () => {
    for (const ok of [MAX_IN_FLIGHT_LIMITS.min, 16, MAX_IN_FLIGHT_LIMITS.max]) {
      expect(parseConfig(doc([{ id: 'a', label: 'A', maxInFlight: ok }], {})).models[0]!.maxInFlight).toBe(ok)
    }
    for (const bad of [0, -1, 257, 1.5]) {
      expect(() => parseConfig(doc([{ id: 'a', label: 'A', maxInFlight: bad }], {}))).toThrow()
    }
  })

  it('description keeps text, turns blank into null, and refuses more than 500 characters', () => {
    expect(parseConfig(doc([{ id: 'a', label: 'A', description: 'fast: research' }], {})).models[0]!.description).toBe('fast: research')
    expect(parseConfig(doc([{ id: 'a', label: 'A', description: '   ' }], {})).models[0]!.description).toBeNull()
    expect(() => parseConfig(doc([{ id: 'a', label: 'A', description: 'x'.repeat(501) }], {}))).toThrow()
  })
})

describe('Settings round trip (PUT → stored → GET)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    version: 1,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible', baseURL: 'http://x/v1', key: null }],
    models: [
      { id: 'r1', providerId: 'p1', modelId: 'q', label: 'R1', dim: null, contextWindow: null, description: null, maxInFlight: null },
      { id: 's1', providerId: 'p1', modelId: 'f', label: 'Fast', dim: null, contextWindow: null, description: 'fast, high concurrency: research', maxInFlight: 12, ...over }
    ],
    assignments: { reasoning: ['r1'], subagents: ['s1', 'r1'] }
  })

  it('subagents, description and maxInFlight survive the save and come back on read', async () => {
    await put({ body: body() })
    expect(saveConfig).toHaveBeenCalledOnce()
    const back = await get({}) as { models: Array<{ id: string; description: string | null; maxInFlight: number | null }>; assignments: Record<string, string[]> }
    expect(back.assignments.subagents).toEqual(['s1', 'r1'])
    expect(back.models.find(m => m.id === 's1')).toMatchObject({ description: 'fast, high concurrency: research', maxInFlight: 12 })
    expect(back.models.find(m => m.id === 'r1')).toMatchObject({ description: null, maxInFlight: null })
  })

  it('an older client that sends neither field still saves (both null)', async () => {
    const b = body()
    for (const m of b.models as Array<Record<string, unknown>>) { delete m.description; delete m.maxInFlight }
    await put({ body: b })
    const back = redactDoc(parseConfig(stored))
    expect(back.models.every(m => m.description === null && m.maxInFlight === null)).toBe(true)
  })

  it('maxInFlight out of 1–256 is a 422 and nothing is saved', async () => {
    for (const bad of [0, 257]) {
      await expect(put({ body: body({ maxInFlight: bad }) })).rejects.toMatchObject({ statusCode: 422 })
    }
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('two subagents models with the same label are a 422 naming the label; nothing is saved', async () => {
    const b = body()
    ;(b.models as Array<Record<string, unknown>>)[0]!.label = 'Fast'
    await expect(put({ body: b })).rejects.toMatchObject({ statusCode: 422, data: expect.stringContaining('"Fast"') })
    expect(saveConfig).not.toHaveBeenCalled()
    // The same label OUTSIDE subagents is fine (only subagents is picked by label).
    const ok = body(); (ok.models as Array<Record<string, unknown>>)[0]!.label = 'Fast'
    ;(ok.assignments as Record<string, string[]>).subagents = ['s1']
    await put({ body: ok })
    expect(saveConfig).toHaveBeenCalledOnce()
  })

  it('an embedding model in subagents is a 422 naming it', async () => {
    const b = body()
    ;(b.models as Array<Record<string, unknown>>).push({ id: 'e1', providerId: 'p1', modelId: 'emb', label: 'Embed', dim: 2560, contextWindow: null, description: null, maxInFlight: null })
    ;(b.assignments as Record<string, string[]>).subagents = ['s1', 'e1']
    await expect(put({ body: b })).rejects.toMatchObject({ statusCode: 422, data: expect.stringContaining('"Embed" is an embedding model') })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('a STORED config with those problems still parses (the rule is save-time only)', () => {
    const d = doc([{ id: 's1', label: 'Same' }, { id: 's2', label: 'Same' }], { subagents: ['s1', 's2'] })
    expect(() => parseConfig(d)).not.toThrow()
  })

  it('a subagents entry naming a missing model is a 422', async () => {
    const b = body(); (b.assignments as Record<string, string[]>).subagents = ['ghost']
    await expect(put({ body: b })).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('child model resolution (resolveSubagentChainFrom)', () => {
  const ids = (c: Array<{ modelDefId: string }>) => c.map(m => m.modelDefId)

  it('label → its model first, then the rest of subagents in order, then the reasoning chain', () => {
    const d = parseConfig(doc([...FOUR, { id: 's3', label: 'Third' }], { reasoning: ['r1', 'r2'], subagents: ['s1', 's2', 's3'] }))
    expect(ids(resolveSubagentChainFrom(d, 'Deep'))).toEqual(['s2', 's1', 's3', 'r1', 'r2'])
    expect(ids(resolveSubagentChainFrom(d, 'Third'))).toEqual(['s3', 's1', 's2', 'r1', 'r2'])
  })

  it('no label → subagents in order (first = default), then reasoning', () => {
    const d = parseConfig(doc(FOUR, { reasoning: ['r1', 'r2'], subagents: ['s2', 's1'] }))
    expect(ids(resolveSubagentChainFrom(d))).toEqual(['s2', 's1', 'r1', 'r2'])
    expect(ids(resolveSubagentChainFrom(d, null))).toEqual(['s2', 's1', 'r1', 'r2'])
  })

  it('empty subagents → the reasoning chain alone', () => {
    const d = parseConfig(doc(FOUR, { reasoning: ['r1', 'r2'] }))
    expect(ids(resolveSubagentChainFrom(d))).toEqual(['r1', 'r2'])
  })

  it('a model in both lists is tried once, at its first position', () => {
    const d = parseConfig(doc(FOUR, { reasoning: ['r1', 's1'], subagents: ['s1', 'r1'] }))
    expect(ids(resolveSubagentChainFrom(d))).toEqual(['s1', 'r1'])
  })

  it('an unknown label is a clear error naming the labels that exist', () => {
    const d = parseConfig(doc(FOUR, { reasoning: ['r1'], subagents: ['s1', 's2'] }))
    expect(() => resolveSubagentChainFrom(d, 'Nope')).toThrow(UnknownSubagentModelError)
    expect(() => resolveSubagentChainFrom(d, 'Nope')).toThrow(/"Fast", "Deep"/)
    // A reasoning model's label is not a subagents label.
    expect(() => resolveSubagentChainFrom(d, 'R1')).toThrow(UnknownSubagentModelError)
    // With no subagents at all, any label is unknown, and the error says to leave it out.
    expect(() => resolveSubagentChainFrom(parseConfig(doc(FOUR, { reasoning: ['r1'] })), 'Fast')).toThrow(/leave the model out/)
  })

  it('nothing configured at all is AiNotConfiguredError', () => {
    expect(() => resolveSubagentChainFrom(parseConfig(doc(FOUR, {})))).toThrow(AiNotConfiguredError)
  })

  it('the cached forms read the stored config', async () => {
    stored = doc(FOUR, { reasoning: ['r1'], subagents: ['s1'] })
    expect(ids(await resolveSubagentModel('Fast'))).toEqual(['s1', 'r1'])
    expect(await listSubagentModels()).toEqual([{ label: 'Fast', description: null, maxInFlight: DEFAULT_MAX_IN_FLIGHT }])
  })
})

describe('listSubagentModelsFrom + pool sizes', () => {
  it('lists subagents in order with description and the effective maxInFlight', () => {
    const d = parseConfig(doc([{ id: 's1', label: 'Fast', description: 'research', maxInFlight: 24 }, { id: 's2', label: 'Deep' }], { subagents: ['s2', 's1'] }))
    expect(listSubagentModelsFrom(d)).toEqual([
      { label: 'Deep', description: null, maxInFlight: DEFAULT_MAX_IN_FLIGHT },
      { label: 'Fast', description: 'research', maxInFlight: 24 }
    ])
  })

  it('poolLimitsFrom: every model → its maxInFlight, unset → the default', () => {
    const d = parseConfig(doc([{ id: 'a', label: 'A', maxInFlight: 3 }, { id: 'b', label: 'B' }], {}))
    expect(poolLimitsFrom(d)).toEqual({ a: 3, b: DEFAULT_MAX_IN_FLIGHT })
  })

  it('the client mirrors of the default and the bound match the server', () => {
    expect(clientConsts.DEFAULT_MAX_IN_FLIGHT).toBe(DEFAULT_MAX_IN_FLIGHT)
    expect(clientConsts.MAX_IN_FLIGHT_MAX).toBe(MAX_IN_FLIGHT_LIMITS.max)
  })
})
