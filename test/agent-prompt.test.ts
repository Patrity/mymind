// test/agent-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { composePrompt, timeOfDayTone } from '../server/lib/agent/prompt'

describe('timeOfDayTone', () => {
  it('buckets by hour', () => {
    expect(timeOfDayTone(new Date('2026-06-17T08:00:00'))).toMatch(/morning/i)
    expect(timeOfDayTone(new Date('2026-06-17T14:00:00'))).toMatch(/afternoon/i)
    expect(timeOfDayTone(new Date('2026-06-17T19:00:00'))).toMatch(/evening/i)
    expect(timeOfDayTone(new Date('2026-06-17T02:00:00'))).toMatch(/late|night/i)
  })
})
describe('composePrompt', () => {
  const base = { persona: 'You are Bridget.', toneLine: 'It is morning.' }
  it('speak mode forbids markdown + adds the filler rule', () => {
    const p = composePrompt({ ...base, speak: true })
    expect(p).toContain('You are Bridget.')
    expect(p).toContain('It is morning.')
    expect(p).toMatch(/no markdown/i)
    expect(p).toMatch(/filler/i)
  })
  it('text mode allows markdown + omits the filler rule', () => {
    const p = composePrompt({ ...base, speak: false })
    expect(p).toMatch(/markdown/i)
    expect(p).not.toMatch(/filler/i)
  })
  it('appends the context block when present', () => {
    expect(composePrompt({ ...base, speak: false, context: 'Active projects: mymind.' })).toContain('Active projects: mymind.')
  })
  it('includes web-research guidance', () => { expect(composePrompt({ persona: 'p', speak: false, toneLine: 't' })).toMatch(/web_search/) })
  it('includes the degraded-search-backend honesty rule', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).toMatch(/warning/i)
    expect(p).toMatch(/do not conclude the information does not exist/i)
  })
  it('forbids narrating a tool call without making it', () => {
    expect(composePrompt({ persona: 'p', speak: false, toneLine: 't' })).toMatch(/NEVER say you are checking\/searching/i)
  })
  it('includes the verify-before-conceding pushback rule', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).toMatch(/do not reflexively agree/i)
  })
  it('includes the exact date/time line when provided', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't', nowLine: 'Current date and time: Wednesday, July 1, 2026, 3:00 PM (America/Chicago).' })
    expect(p).toContain('Current date and time: Wednesday, July 1, 2026')
  })
  it('includes subagent delegation guidance', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).toMatch(/research_web/)
    expect(p).toMatch(/search_brain/)
    expect(p).toMatch(/cannot see this conversation/i)
  })
})

describe('composePrompt always-armed exec guidance', () => {
  it('always includes exec + approval guidance (the powerful/exec levers are gone)', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).toMatch(/`exec` tool/)
    expect(p).toMatch(/approv/i) // mentions the approval requirement
    expect(p).toMatch(/Catastrophic commands/i)
  })
})

describe('nowLine', () => {
  it('formats an exact timestamp with timezone', async () => {
    const { nowLine } = await import('../server/lib/agent/prompt')
    const line = nowLine(new Date('2026-07-01T15:04:00'))
    expect(line).toMatch(/^Current date and time: /)
    expect(line).toMatch(/2026/)
    expect(line).toMatch(/\(.+\)\.$/) // trailing (timezone).
  })
})
