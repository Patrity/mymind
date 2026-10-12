// Cycle 84 Task 1 — the agent settings doc's judge fields: defaults, tolerant reads, strict patches.
import { describe, it, expect } from 'vitest'
import { agentSettingsPatchSchema, defaultAgentSettings, mergeAgentSettings, readAgentSettings } from './agent-settings'

describe('agent settings — judge fields', () => {
  it('defaults: judge on, workstreams on, chat off, confidence 0.9', () => {
    expect(defaultAgentSettings()).toEqual({ judge: { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 } })
    expect(readAgentSettings(undefined)).toEqual(defaultAgentSettings())
    expect(readAgentSettings(null)).toEqual(defaultAgentSettings())
    expect(readAgentSettings({ other: 1 })).toEqual(defaultAgentSettings())
  })

  it('defaults are fresh objects (no shared mutable state)', () => {
    const a = defaultAgentSettings()
    a.judge.smartApprovals.chat = true
    expect(defaultAgentSettings().judge.smartApprovals.chat).toBe(false)
  })

  it('reads stored values, each invalid field falling back on its own', () => {
    expect(readAgentSettings({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: true }, confidence: 0.75 } }))
      .toEqual({ judge: { enabled: false, smartApprovals: { workstreams: false, chat: true }, confidence: 0.75 } })
    expect(readAgentSettings({ judge: { enabled: 'yes', smartApprovals: { chat: 1 }, confidence: 0.1 } }))
      .toEqual(defaultAgentSettings())
  })

  it.each([0.49, 1, 0, -1, Number.NaN, '0.9'])('a stored confidence of %s reads as the default, never a lower threshold', (c) => {
    expect(readAgentSettings({ judge: { confidence: c } }).judge.confidence).toBe(0.9)
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
