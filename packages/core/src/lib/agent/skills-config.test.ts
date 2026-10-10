import { describe, it, expect } from 'vitest'
import { SKILLS_ENABLED_KEY, invalidateSkillsEnabled } from './skills-config'

describe('skills-config', () => {
  it('uses a stable settings key', () => {
    expect(SKILLS_ENABLED_KEY).toBe('agent_skills_enabled')
  })
  it('exposes cache invalidation (mirrors persona.ts)', () => {
    expect(() => invalidateSkillsEnabled()).not.toThrow()
  })
})
