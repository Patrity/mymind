// validateSkill is the SOLE gate on skill creation — the agent's own `create_skill` tool
// (server/lib/agent/tools.ts) writes skills autonomously — and it shipped with no test at all.
import { describe, it, expect } from 'vitest'
import { validateSkill, SKILL_BODY_MAX } from '../server/services/skills'
import { COMMAND_NAME_RE, RESERVED_COMMAND_NAMES } from '../shared/types/commands'

const ok = { name: 'browser-testing', description: 'd', whenToUse: 'w', body: 'b' }

describe('validateSkill', () => {
  it('accepts a well-formed kebab-case skill', () => {
    expect(validateSkill(ok)).toEqual({ ok: true })
  })

  it('rejects a reserved name', () => {
    const r = validateSkill({ ...ok, name: 'clear' })
    expect(r).toEqual({ ok: false, error: '"clear" is a reserved command name' })
  })

  it('rejects a PADDED reserved name — createSkill stores the trimmed one', () => {
    // The kebab-case check always ran on the trimmed name while the reserved check ran on
    // the raw one, so `" clear "` validated and landed as a skill named `clear`: permanently
    // shadowed by the built-in and unreachable from `/`.
    const r = validateSkill({ ...ok, name: ' clear ' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/reserved/)
  })

  it('rejects a reserved name padded with a newline', () => {
    const r = validateSkill({ ...ok, name: 'new\n' })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/reserved/)
  })

  it('rejects every reserved name, however it is padded', () => {
    // Derived from the list, so a new client command cannot quietly go unguarded.
    for (const name of RESERVED_COMMAND_NAMES) {
      expect(validateSkill({ ...ok, name }).ok).toBe(false)
      expect(validateSkill({ ...ok, name: `\t${name} ` }).ok).toBe(false)
    }
  })

  it('accepts a non-reserved name that merely contains a reserved one', () => {
    expect(validateSkill({ ...ok, name: 'clear-cache' })).toEqual({ ok: true })
  })

  it('rejects a name that is not kebab-case', () => {
    expect(validateSkill({ ...ok, name: 'Clear' })).toEqual({
      ok: false, error: 'name must be kebab-case (got "Clear")'
    })
    expect(validateSkill({ ...ok, name: 'daily standup' }).ok).toBe(false)
  })

  it('rejects a missing name', () => {
    expect(validateSkill({ ...ok, name: '   ' })).toEqual({ ok: false, error: 'name is required' })
  })

  it('requires description, whenToUse and body', () => {
    for (const k of ['description', 'whenToUse', 'body'] as const) {
      expect(validateSkill({ ...ok, [k]: '  ' })).toEqual({ ok: false, error: `${k} is required` })
    }
  })

  it('rejects a body past the cap', () => {
    const r = validateSkill({ ...ok, body: 'x'.repeat(SKILL_BODY_MAX + 1) })
    expect(r.ok).toBe(false)
  })

  it('validates against the shared command-name shape, not a private copy', () => {
    // Skills and prompt macros share one `/` namespace; two regexes would drift.
    expect(COMMAND_NAME_RE.test('browser-testing')).toBe(true)
    expect(COMMAND_NAME_RE.test('Browser-Testing')).toBe(false)
  })
})
