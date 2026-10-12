// Cycle 84 Task 1 — the agent settings doc's judge fields: defaults, tolerant reads, strict patches.
import { describe, it, expect } from 'vitest'
import { agentSettingsPatchSchema, defaultAgentSettings, mergeAgentSettings, readAgentSettings } from './agent-settings'

describe('agent settings — judge fields', () => {
  it('defaults: judge on, workstreams on, chat off, confidence 0.9', () => {
    expect(defaultAgentSettings()).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 } })
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
      .toEqual({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: true }, confidence: 0.75 } })
    expect(readAgentSettings({ judge: {} })).toEqual(defaultAgentSettings())
    expect(readAgentSettings({ judge: { smartApprovals: {} } })).toEqual(defaultAgentSettings())
  })

  it('a present but invalid field fails closed: booleans read false (fix round 1)', () => {
    expect(readAgentSettings({ judge: { enabled: 'yes', smartApprovals: { workstreams: 1, chat: 'true' } } }).judge)
      .toEqual({ enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: 0.9 })
    expect(readAgentSettings({ judge: { smartApprovals: 'on' } }).judge.smartApprovals).toEqual({ workstreams: false, chat: false })
    expect(readAgentSettings({ judge: { enabled: null } }).judge.enabled).toBe(false)
  })

  it.each([['a string', 'corrupt'], ['an array', []], ['a number', 7]])('a corrupt row (%s) reads as everything off', (_n, raw) => {
    expect(readAgentSettings(raw)).toEqual({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: 0.99 } })
  })

  it.each([['a string', 'x'], ['null', null], ['an array', [1]]])('a corrupt judge value (%s) reads as everything off', (_n, j) => {
    expect(readAgentSettings({ judge: j }).judge.enabled).toBe(false)
  })

  it.each([0.49, 1, 0, -1, Number.NaN, '0.9', null])('a stored confidence of %s reads as the strictest threshold (0.99), never lower', (c) => {
    expect(readAgentSettings({ judge: { confidence: c } }).judge.confidence).toBe(0.99)
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
    ['unknown top-level field', { persona: 'x' }]
  ])('a patch with %s is rejected', (_n, body) => {
    expect(agentSettingsPatchSchema.safeParse(body).success).toBe(false)
  })

  it('a patch merges onto the current settings, leaving the rest alone', () => {
    const cur = defaultAgentSettings()
    const patch = agentSettingsPatchSchema.parse({ judge: { smartApprovals: { chat: true } } })
    expect(mergeAgentSettings(cur, patch)).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: true, chat: true }, confidence: 0.9 } })
    expect(mergeAgentSettings(cur, agentSettingsPatchSchema.parse({}))).toEqual(cur)
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
  it('names every field read fail-closed', async () => {
    const { agentSettingsProblems } = await import('./agent-settings')
    expect(agentSettingsProblems('x')).toEqual(['the settings document'])
    expect(agentSettingsProblems([1])).toEqual(['the settings document'])
    expect(agentSettingsProblems({ judge: 'on' })).toEqual(['judge'])
    expect(agentSettingsProblems({ judge: null })).toEqual(['judge'])
    expect(agentSettingsProblems({ judge: { enabled: 'yes', smartApprovals: { workstreams: 1, chat: true }, confidence: 2 } }))
      .toEqual(['judge.enabled', 'judge.smartApprovals.workstreams', 'judge.confidence'])
    expect(agentSettingsProblems({ judge: { smartApprovals: [] } })).toEqual(['judge.smartApprovals'])
    expect(agentSettingsProblems({ judge: { smartApprovals: { chat: 'no' } } })).toEqual(['judge.smartApprovals.chat'])
  })
})
