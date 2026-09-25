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

  it('caps the body to SKILL_TIER_MAX_CHARS exactly, joiner included', async () => {
    const huge = 'y'.repeat(SKILL_TIER_MAX_CHARS * 4)
    const r = await assembleContext({
      userText: 'go', skill: 'big', budget: 4000,
      deps: deps({ getSkillBody: async () => huge })
    })
    // The body is the tier minus its wrapper prefix; a joiner that pushes the result
    // PAST the declared cap makes the constant a lie, so assert the real ceiling.
    const body = r.context.slice(r.context.indexOf('skill:\n') + 'skill:\n'.length)
    expect(body.length).toBeLessThanOrEqual(SKILL_TIER_MAX_CHARS)
  })

  // The skill is resolved OUTSIDE the 1500ms race (assembleContext), unlike every other tier.
  // The composer has already stripped "/browser-testing" out of the message text by the time
  // this runs, so a timeout used to send the turn as the bare argument with no skill loaded
  // and no trace one was named — the user watches Bridget ignore an explicit instruction and
  // the transcript shows a message that never mentioned the skill.
  const never = <T>() => new Promise<T>(() => {})

  it('still carries the skill tier when the assembly times out on search', async () => {
    const r = await assembleContext({
      userText: 'validate the review page', skill: 'browser-testing', budget: 4000, timeoutMs: 20,
      deps: deps({ getSkillBody: async () => 'STEP ONE: open the browser.', search: () => never<MemoryDTO[]>() })
    })
    expect(r.context).toContain('STEP ONE: open the browser.')
    expect(r.context).toContain('browser-testing')
    expect(r.used).toBeGreaterThan(0)
  })

  it('still carries the skill tier when a tier that used to share its Promise.all hangs', async () => {
    // Pre-fix the skill lookup sat in the SAME Promise.all as resident/live/summary, so any
    // one of them hanging took the skill down with it.
    const r = await assembleContext({
      userText: 'go', skill: 'browser-testing', budget: 4000, timeoutMs: 20,
      deps: deps({ getSkillBody: async () => 'STEP ONE: open the browser.', listResident: () => never<MemoryDTO[]>() })
    })
    expect(r.context).toContain('STEP ONE: open the browser.')
  })

  it('caps the skill body on the timeout path too', async () => {
    const huge = 'y'.repeat(SKILL_TIER_MAX_CHARS * 4)
    const r = await assembleContext({
      userText: 'go', skill: 'big', budget: 4000, timeoutMs: 20,
      deps: deps({ getSkillBody: async () => huge, search: () => never<MemoryDTO[]>() })
    })
    expect(r.context.length).toBeLessThan(huge.length)
  })

  it('still degrades to an empty context on timeout when NO skill was named', async () => {
    // The exemption is for an explicitly-requested skill only; proactive retrieval keeps the
    // best-effort policy it was given in cycle 70.
    const r = await assembleContext({
      userText: 'go', budget: 4000, timeoutMs: 20,
      deps: deps({ search: () => never<MemoryDTO[]>(), liveContext: async () => 'Active projects: mymind.' })
    })
    expect(r.context).toBe('')
    expect(r.used).toBe(0)
  })

  it('degrades to a normal turn when the skill does not resolve', async () => {
    const r = await assembleContext({
      userText: 'go', skill: 'missing', budget: 4000,
      deps: deps({ getSkillBody: async () => null, liveContext: async () => 'Active projects: mymind.' })
    })
    expect(r.context).toContain('Active projects: mymind.')
  })
})
