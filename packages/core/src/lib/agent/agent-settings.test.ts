// Cycle 84 Task 1 — the agent settings doc's judge fields: defaults, tolerant reads, strict patches.
import { describe, it, expect } from 'vitest'
import { agentSettingsPatchSchema, defaultAgentSettings, mergeAgentSettings, readAgentSettings } from './agent-settings'

const CAPS = { guard: 4, approval: 2, outcome: 2 }
const EVAL = { concurrency: 2, maxTokensPerRun: 5_000_000 } // NODE_ENV is 'test' here: the non-production default

describe('agent settings — judge fields', () => {
  it('defaults (final fix wave M4): judge on, Smart Approvals OFF on both surfaces, confidence 0.9, 4 in flight', () => {
    expect(defaultAgentSettings()).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: false, chat: false }, confidence: 0.9, maxInFlight: CAPS }, eval: EVAL, taintConfinement: true })
    expect(readAgentSettings(undefined)).toEqual(defaultAgentSettings())
    expect(readAgentSettings(null)).toEqual(defaultAgentSettings())
    expect(readAgentSettings({ other: 1 })).toEqual(defaultAgentSettings())
    expect(readAgentSettings({ judge: undefined })).toEqual(defaultAgentSettings())
  })

  it('defaults are fresh objects (no shared mutable state)', () => {
    const a = defaultAgentSettings()
    a.judge.smartApprovals.chat = true
    expect(defaultAgentSettings().judge.smartApprovals.chat).toBe(false)
  })

  it('reads stored values; a missing field reads as its default', () => {
    expect(readAgentSettings({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: true }, confidence: 0.75 } }))
      .toEqual({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: true }, confidence: 0.75, maxInFlight: CAPS }, eval: EVAL, taintConfinement: true })
    expect(readAgentSettings({ judge: { smartApprovals: { workstreams: true } } }).judge.smartApprovals).toEqual({ workstreams: true, chat: false })
    expect(readAgentSettings({ judge: {} })).toEqual(defaultAgentSettings())
    expect(readAgentSettings({ judge: { smartApprovals: {} } })).toEqual(defaultAgentSettings())
  })

  it('a present but invalid field fails closed: booleans read false (fix round 1)', () => {
    expect(readAgentSettings({ judge: { enabled: 'yes', smartApprovals: { workstreams: 1, chat: 'true' } } }).judge)
      .toEqual({ enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: 0.9, maxInFlight: CAPS })
    expect(readAgentSettings({ judge: { smartApprovals: 'on' } }).judge.smartApprovals).toEqual({ workstreams: false, chat: false })
    expect(readAgentSettings({ judge: { enabled: null } }).judge.enabled).toBe(false)
  })

  it.each([['a string', 'corrupt'], ['an array', []], ['a number', 7]])('a corrupt row (%s) reads as everything off', (_n, raw) => {
    expect(readAgentSettings(raw)).toEqual({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: 0.99, maxInFlight: CAPS }, eval: EVAL, taintConfinement: true })
  })

  it.each([['a string', 'x'], ['null', null], ['an array', [1]]])('a corrupt judge value (%s) reads as everything off', (_n, j) => {
    expect(readAgentSettings({ judge: j }).judge.enabled).toBe(false)
  })

  it.each([0.49, 1, 0, -1, Number.NaN, '0.9', null])('a stored confidence of %s reads as the strictest threshold (0.99), never lower', (c) => {
    expect(readAgentSettings({ judge: { confidence: c } }).judge.confidence).toBe(0.99)
  })

  it.each([0, 17, 2.5, '4', null])('I5: a stored maxInFlight of %s reads as the defaults (a capacity knob, not a switch)', (n) => {
    expect(readAgentSettings({ judge: { maxInFlight: n } }).judge.maxInFlight).toEqual(CAPS)
  })

  it('I5 / cycle 85 I1: a stored bare number in 1–16 is the guard cap; an object is read per class', () => {
    expect(readAgentSettings({ judge: { maxInFlight: 1 } }).judge.maxInFlight).toEqual({ ...CAPS, guard: 1 })
    expect(readAgentSettings({ judge: { maxInFlight: 16 } }).judge.maxInFlight).toEqual({ ...CAPS, guard: 16 })
    expect(readAgentSettings({ judge: { maxInFlight: { guard: 6, approval: 3, outcome: 1 } } }).judge.maxInFlight).toEqual({ guard: 6, approval: 3, outcome: 1 })
    expect(readAgentSettings({ judge: { maxInFlight: { outcome: 0, approval: 5 } } }).judge.maxInFlight).toEqual({ guard: 4, approval: 5, outcome: 2 })
  })

  it('cycle 85 final fix wave: the eval knobs — defaults, stored values, invalid → default; the prod default concurrency is 1', async () => {
    expect(readAgentSettings({ eval: { concurrency: 3, maxTokensPerRun: 200_000 } }).eval).toEqual({ concurrency: 3, maxTokensPerRun: 200_000 })
    expect(readAgentSettings({ eval: { concurrency: 5, maxTokensPerRun: 10 } }).eval).toEqual(EVAL)
    expect(readAgentSettings({ eval: 'x', judge: { enabled: true } }).eval).toEqual(EVAL)
    const { defaultEvalConcurrency } = await import('./agent-settings')
    const env = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      expect(defaultEvalConcurrency()).toBe(1)
      expect(readAgentSettings(undefined).eval.concurrency).toBe(1)
    } finally { process.env.NODE_ENV = env }
  })

  it('accepts the bounds 0.5 and 0.99', () => {
    expect(readAgentSettings({ judge: { confidence: 0.5 } }).judge.confidence).toBe(0.5)
    expect(agentSettingsPatchSchema.safeParse({ judge: { confidence: 0.99 } }).success).toBe(true)
  })

  it.each([
    ['confidence too low', { judge: { confidence: 0.4 } }],
    ['confidence too high', { judge: { confidence: 1 } }],
    ['confidence a string', { judge: { confidence: '0.9' } }],
    ['enabled not a boolean', { judge: { enabled: 'true' } }],
    ['unknown judge field', { judge: { auto: true } }],
    ['unknown smartApprovals field', { judge: { smartApprovals: { headless: true } } }],
    ['unknown top-level field', { persona: 'x' }],
    ['maxInFlight 0', { judge: { maxInFlight: 0 } }],
    ['maxInFlight 17', { judge: { maxInFlight: 17 } }],
    ['maxInFlight fractional', { judge: { maxInFlight: 2.5 } }],
    ['maxInFlight class 0', { judge: { maxInFlight: { outcome: 0 } } }],
    ['maxInFlight unknown class', { judge: { maxInFlight: { rubric: 2 } } }],
    ['eval concurrency 5', { eval: { concurrency: 5 } }],
    ['eval concurrency 0', { eval: { concurrency: 0 } }],
    ['eval budget too small', { eval: { maxTokensPerRun: 10 } }],
    ['unknown eval field', { eval: { n: 3 } }]
  ])('a patch with %s is rejected', (_n, body) => {
    expect(agentSettingsPatchSchema.safeParse(body).success).toBe(false)
  })

  it('a patch merges onto the current settings, leaving the rest alone', () => {
    const cur = defaultAgentSettings()
    const patch = agentSettingsPatchSchema.parse({ judge: { smartApprovals: { chat: true } } })
    expect(mergeAgentSettings(cur, patch)).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: false, chat: true }, confidence: 0.9, maxInFlight: CAPS }, eval: EVAL, taintConfinement: true })
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({ judge: { maxInFlight: 8 } })).judge.maxInFlight).toEqual({ ...CAPS, guard: 8 })
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({ judge: { maxInFlight: { outcome: 3 } } })).judge.maxInFlight).toEqual({ ...CAPS, outcome: 3 })
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({ eval: { concurrency: 1 } })).eval).toEqual({ ...EVAL, concurrency: 1 })
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({}))).toEqual(cur)
  })
})

describe('taintConfinement (cycle 86, D6): one switch, default on, fails closed to ON', () => {
  it('missing → on; stored false → off; anything else (a string, a number, a corrupt row) → on', () => {
    expect(defaultAgentSettings().taintConfinement).toBe(true)
    expect(readAgentSettings(undefined).taintConfinement).toBe(true)
    expect(readAgentSettings({ judge: { enabled: true } }).taintConfinement).toBe(true)
    expect(readAgentSettings({ taintConfinement: false }).taintConfinement).toBe(false)
    expect(readAgentSettings({ taintConfinement: false, judge: 'corrupt' }).taintConfinement).toBe(false)
    for (const raw of ['off', 0, null, 'false', {}]) expect(readAgentSettings({ taintConfinement: raw }).taintConfinement, String(raw)).toBe(true)
    expect(readAgentSettings('corrupt').taintConfinement).toBe(true)
  })
  it('a patch sets it (strictly a boolean) and leaves the rest alone', () => {
    const cur = defaultAgentSettings()
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({ taintConfinement: false }))).toEqual({ ...cur, taintConfinement: false })
    expect(mergeAgentSettings({ ...cur, taintConfinement: false }, agentSettingsPatchSchema.parse({ judge: { enabled: false } })).taintConfinement).toBe(false)
    expect(() => agentSettingsPatchSchema.parse({ taintConfinement: 'off' })).toThrow()
  })
})

describe('agentSettingsProblems (Task 4 fix round 1, M1)', () => {
  it('a missing or valid row has none', async () => {
    const { agentSettingsProblems } = await import('./agent-settings')
    expect(agentSettingsProblems(undefined)).toEqual([])
    expect(agentSettingsProblems(null)).toEqual([])
    expect(agentSettingsProblems({ other: 1 })).toEqual([])
    expect(agentSettingsProblems({ judge: { enabled: false, smartApprovals: { workstreams: true, chat: false }, confidence: 0.95 } })).toEqual([])
    expect(agentSettingsProblems({ judge: { enabled: true } })).toEqual([])
  })
  it('cycle 86: a stored taintConfinement that is not a boolean is named', async () => {
    const { agentSettingsProblems } = await import('./agent-settings')
    expect(agentSettingsProblems({ taintConfinement: 'off' })).toEqual(['taintConfinement'])
    expect(agentSettingsProblems({ taintConfinement: false })).toEqual([])
  })
  it('names every field read fail-closed', async () => {
    const { agentSettingsProblems } = await import('./agent-settings')
    expect(agentSettingsProblems('x')).toEqual(['the settings document'])
    expect(agentSettingsProblems([1])).toEqual(['the settings document'])
    expect(agentSettingsProblems({ judge: 'on' })).toEqual(['judge'])
    expect(agentSettingsProblems({ judge: null })).toEqual(['judge'])
    expect(agentSettingsProblems({ judge: { enabled: 'yes', smartApprovals: { workstreams: 1, chat: true }, confidence: 2 } }))
      .toEqual(['judge.enabled', 'judge.smartApprovals.workstreams', 'judge.confidence'])
    expect(agentSettingsProblems({ judge: { maxInFlight: 0 } })).toEqual(['judge.maxInFlight'])
    expect(agentSettingsProblems({ judge: { maxInFlight: { guard: 4, outcome: 99 } } })).toEqual(['judge.maxInFlight.outcome'])
    expect(agentSettingsProblems({ judge: { maxInFlight: { guard: 4, approval: 2, outcome: 2 } } })).toEqual([])
    expect(agentSettingsProblems({ eval: { concurrency: 9 } })).toEqual(['eval.concurrency'])
    expect(agentSettingsProblems({ judge: { smartApprovals: [] } })).toEqual(['judge.smartApprovals'])
    expect(agentSettingsProblems({ judge: { smartApprovals: { chat: 'no' } } })).toEqual(['judge.smartApprovals.chat'])
  })
})
