import { describe, it, expect, vi } from 'vitest'
import { assembleContext, SKILL_TIER_MAX_CHARS } from '../server/lib/agent/assemble'
import type { MemoryDTO } from '../shared/types/memory'

const deps = (over: Record<string, unknown> = {}) => ({
  listResident: async () => [] as MemoryDTO[],
  search: async () => [] as MemoryDTO[],
  liveContext: async () => '',
  summary: async () => null as string | null,
  recordRetrievals: async () => {},
  ...over
})

describe('assembleContext with a skill', () => {
  it('injects the skill body when a skill is named', async () => {
    const getSkillBody = vi.fn(async () => 'STEP ONE: open the browser.')
    const r = await assembleContext({
      userText: 'validate the review page', skill: 'browser-testing', budget: 4000,
      deps: deps({ getSkillBody })
    })
    expect(getSkillBody).toHaveBeenCalledWith('browser-testing')
    expect(r.context).toContain('STEP ONE: open the browser.')
  })

  it('does not resolve a skill when none is named', async () => {
    const getSkillBody = vi.fn(async () => 'never')
    await assembleContext({ userText: 'hi', budget: 4000, deps: deps({ getSkillBody }) })
    expect(getSkillBody).not.toHaveBeenCalled()
  })

  it('caps an oversized skill body rather than overflowing the budget', async () => {
    const huge = 'y'.repeat(SKILL_TIER_MAX_CHARS * 4)
    const r = await assembleContext({
      userText: 'go', skill: 'big', budget: 4000,
      deps: deps({ getSkillBody: async () => huge })
    })
    expect(r.context.length).toBeLessThan(huge.length)
    expect(r.context).toContain('…')
  })

  it('degrades to a normal turn when the skill does not resolve', async () => {
    const r = await assembleContext({
      userText: 'go', skill: 'missing', budget: 4000,
      deps: deps({ getSkillBody: async () => null, liveContext: async () => 'Active projects: mymind.' })
    })
    expect(r.context).toContain('Active projects: mymind.')
  })
})
