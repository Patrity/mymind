// The prompt's wall-clock lines use Tony's timezone (the `agent_timezone` setting), not the
// server's: prod runs on UTC, so 20:30 in Chicago read as ~01:30 and Bridget thought it was 2am.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tzMock = vi.hoisted(() => ({ getDefaultTimezone: vi.fn(), serverTimezone: vi.fn(() => 'UTC') }))
vi.mock('../server/lib/agent/jobs/timezone', () => tzMock)
vi.mock('../server/lib/agent/persona', () => ({ loadPersona: vi.fn(async () => 'persona') }))
vi.mock('../server/lib/agent/skills-config', () => ({ skillsEnabled: vi.fn(async () => false) }))
vi.mock('../server/services/skills', () => ({ listSkills: vi.fn(async () => []) }))

import { buildSystemPrompt, nowLine, timeOfDayTone } from '../server/lib/agent/prompt'

const AT = new Date('2026-09-29T01:30:00Z') // 20:30 in America/Chicago (CDT)

describe('prompt time lines in the agent timezone', () => {
  beforeEach(() => { tzMock.getDefaultTimezone.mockReset() })

  it('nowLine formats the wall clock in the given zone', () => {
    const line = nowLine(AT, 'America/Chicago')
    expect(line).toContain('8:30 PM')
    expect(line).toContain('Monday, September 28, 2026')
    expect(line).toMatch(/\(America\/Chicago\)\.$/)
  })

  it('timeOfDayTone uses the hour in the given zone', () => {
    expect(timeOfDayTone(AT, 'America/Chicago')).toMatch(/evening/i)
    expect(timeOfDayTone(AT, 'UTC')).toMatch(/late|night/i)
  })

  it('buildSystemPrompt reads the agent timezone setting', async () => {
    tzMock.getDefaultTimezone.mockResolvedValue('America/Chicago')
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).toContain('8:30 PM')
    expect(p).toContain('(America/Chicago)')
    expect(p).toMatch(/evening/i)
  })

  it('falls back to the server zone when the setting cannot be read', async () => {
    tzMock.getDefaultTimezone.mockRejectedValue(new Error('db down'))
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).toContain('1:30 AM')
    expect(p).toContain('(UTC)')
  })
})

describe('live context date in the agent timezone', () => {
  it('is the Chicago date, not the UTC one, late in the evening', async () => {
    const { contextDate } = await import('../server/lib/agent/context')
    expect(contextDate(AT, 'America/Chicago')).toBe('2026-09-28')
    expect(contextDate(AT, 'UTC')).toBe('2026-09-29')
  })
})
