// The prompt's wall-clock lines use Tony's timezone (the `agent_timezone` setting), not the
// server's: prod runs on UTC, so 20:30 in Chicago read as ~01:30 and Bridget thought it was 2am.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tzMock = vi.hoisted(() => ({ getDefaultTimezone: vi.fn(), serverTimezone: vi.fn(() => 'UTC') }))
vi.mock('@mymind/core/lib/agent/jobs/timezone', () => tzMock)
vi.mock('@mymind/core/lib/agent/persona', () => ({ loadPersona: vi.fn(async () => 'persona') }))
vi.mock('@mymind/core/lib/agent/skills-config', () => ({ skillsEnabled: vi.fn(async () => false) }))
vi.mock('@mymind/core/services/skills', () => ({ listSkills: vi.fn(async () => []) }))
// Cycle 76, Task 2: the "About Tony" profile the prompt injects — mocked here so these tests
// never hit the DB. Defaults to an empty profile (no section emitted); individual tests below
// override it to prove the injection and the never-throws-on-failure contract.
const getProfileSource = vi.hoisted(() => vi.fn())
vi.mock('@mymind/core/services/profile', () => ({ getProfileSource }))

import { buildSystemPrompt, nowLine, timeOfDayTone } from '@mymind/core/lib/agent/prompt'

const AT = new Date('2026-09-29T01:30:00Z') // 20:30 in America/Chicago (CDT)

beforeEach(() => {
  getProfileSource.mockReset()
  getProfileSource.mockResolvedValue({ content: '', contentHash: 'h', updatedBy: 'human', updatedAt: '2026-01-01T00:00:00.000Z' })
})

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

describe('buildSystemPrompt — "About Tony" profile injection (cycle 76, Task 2)', () => {
  beforeEach(() => { tzMock.getDefaultTimezone.mockResolvedValue('UTC') })

  it('injects the profile under "## About Tony" when the store has content', async () => {
    getProfileSource.mockResolvedValue({ content: 'Likes terse answers.', contentHash: 'h', updatedBy: 'human', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).toContain('## About Tony\nLikes terse answers.')
  })

  it('never throws and emits no profile section when the store load fails', async () => {
    getProfileSource.mockRejectedValue(new Error('db down'))
    await expect(buildSystemPrompt({ speak: false, now: AT })).resolves.not.toThrow()
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).not.toContain('About Tony')
  })

  it('omits the section entirely for an empty/whitespace-only profile', async () => {
    getProfileSource.mockResolvedValue({ content: '   \n  ', contentHash: 'h', updatedBy: 'human', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).not.toContain('About Tony')
  })

  it('clamps an over-budget profile and still never throws', async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} xxxxxxxxxx`).join('\n')
    getProfileSource.mockResolvedValue({ content: long, contentHash: 'h', updatedBy: 'human', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p = await buildSystemPrompt({ speak: false, now: AT })
    expect(p).toContain('…(profile truncated)')
  })
})

describe('live context date in the agent timezone', () => {
  it('is the Chicago date, not the UTC one, late in the evening', async () => {
    const { contextDate } = await import('@mymind/core/lib/agent/context')
    expect(contextDate(AT, 'America/Chicago')).toBe('2026-09-28')
    expect(contextDate(AT, 'UTC')).toBe('2026-09-29')
  })
})
