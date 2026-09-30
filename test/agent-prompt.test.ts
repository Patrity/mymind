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
  // Task 8 (agent-skills cycle): the degraded-search-backend detail moved out of the
  // always-on prompt and into the `web-research-etiquette` skill — see
  // server/lib/agent/prompt.test.ts > "composePrompt — detail migrated into skills".
  it('no longer carries the degraded-search-backend detail inline (migrated to the web-research-etiquette skill)', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).not.toMatch(/do not conclude the information does not exist/i)
    expect(p).toMatch(/web-research-etiquette/)
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
  // Task 8: same migration — the diminishing-returns/bot-wall detail is now in the skill.
  it('no longer carries search-discipline detail inline (diminishing returns + bot walls migrated to skill)', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).not.toMatch(/diminishing returns/i)
    expect(p).not.toMatch(/bot walls/i)
    expect(p).not.toMatch(/eBay sold listings/)
  })
  it('includes subagent delegation guidance', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).toMatch(/research_web/)
    expect(p).toMatch(/search_brain/)
    expect(p).toMatch(/cannot see this conversation/i)
  })
})

// Cycle 76, Task 2: the "About Tony" profile — injected right after the persona, before the
// tone line / date / anything else. Omitted entirely when there is no profile text.
describe('composePrompt — "About Tony" profile (cycle 76)', () => {
  it('emits the profile under a heading right after the persona', () => {
    const p = composePrompt({ persona: 'You are Bridget.', speak: false, toneLine: 'TONE_MARKER', profile: 'Likes terse answers.' })
    expect(p).toContain('## About Tony\nLikes terse answers.')
    // Right after the persona: the persona line, then the About Tony block, then the tone line.
    expect(p.indexOf('You are Bridget.')).toBeLessThan(p.indexOf('## About Tony'))
    expect(p.indexOf('## About Tony')).toBeLessThan(p.indexOf('TONE_MARKER'))
  })
  it('omits the section entirely when no profile is supplied', () => {
    const p = composePrompt({ persona: 'p', speak: false, toneLine: 't' })
    expect(p).not.toContain('About Tony')
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

describe('wake mode', () => {
  const opts = { persona: 'P', speak: false, toneLine: 'T' }
  it('adds the wake section and the NO_REPLY contract', () => {
    const p = composePrompt({ ...opts, wake: { reason: 'admin' } })
    expect(p).toContain('You were woken by: admin')
    expect(p).toContain('reply with exactly NO_REPLY')
  })
  it('drops the confirm-before-editing rule, which cannot be honoured with nobody there', () => {
    expect(composePrompt({ ...opts, wake: { reason: 'x' } })).not.toContain('CONFIRM with Tony first')
    expect(composePrompt(opts)).toContain('CONFIRM with Tony first')
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
