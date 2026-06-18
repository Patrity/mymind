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
})
