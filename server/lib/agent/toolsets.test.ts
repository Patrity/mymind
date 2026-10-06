import { describe, it, expect } from 'vitest'
import { TOOLSETS, parseToolsetIds, activeToolNames, directoryText, ON_DEMAND_TOOLSETS } from './toolsets'
import { bridgetProfile } from './profile'
import type { AgentTool } from './types'

const t = (name: string, toolset: AgentTool['toolset']): AgentTool =>
  ({ name, toolset, description: name, kind: 'read', schema: {}, handler: async () => ({ result: null, summary: '' }) })

describe('toolset registry', () => {
  it('every Bridget tool has a known toolset', () => {
    for (const tool of bridgetProfile.tools) expect(TOOLSETS[tool.toolset], tool.name).toBeDefined()
  })
  it('every on-demand toolset has a directory line and at least one tool', () => {
    for (const id of ON_DEMAND_TOOLSETS) {
      expect(TOOLSETS[id].description.length, id).toBeGreaterThan(10)
      expect(bridgetProfile.tools.some(x => x.toolset === id), id).toBe(true)
    }
  })
  it('core is ~25 tools (spec §3)', () => {
    const core = activeToolNames(bridgetProfile.tools, new Set())
    expect(core.length).toBeGreaterThanOrEqual(22)
    expect(core.length).toBeLessThanOrEqual(28)
    expect(core).toEqual(expect.arrayContaining(['search_tasks', 'web_search', 'exec', 'search_memories', 'search_docs']))
    expect(core).not.toContain('generate_image')
    expect(core).not.toContain('search_sessions')
  })
  it('spec §3 placements', () => {
    const where = Object.fromEntries(bridgetProfile.tools.map(x => [x.name, x.toolset]))
    expect(where).toMatchObject({
      search_sessions: 'history', read_around_message: 'history', search_projects: 'projects',
      move_document: 'doc-admin', generate_image: 'images', schedule_wake: 'jobs', create_skill: 'skill-admin',
      decide_review: 'reviews', list_improvements: 'improvements', send_message: 'channels',
      research_web: 'web', gmail_search: 'gmail', gmail_draft: 'gmail', contacts_search: 'gmail', calendar_list_events: 'calendar', calendar_guest_event: 'calendar', calendar_rsvp: 'calendar', search_brain: 'web', exec: 'core', use_skill: 'core', quick_capture: 'tasks'
    })
  })
})

describe('parseToolsetIds', () => {
  it('keeps known on-demand ids, drops core/unknown/non-strings, dedups', () => {
    expect(parseToolsetIds(['images', 'memory', 'nope', 3, 'images', 'jobs'])).toEqual(['images', 'jobs'])
  })
  it('non-array → []', () => {
    expect(parseToolsetIds(null)).toEqual([])
    expect(parseToolsetIds('images')).toEqual([])
  })
})

describe('activeToolNames', () => {
  const reg = [t('a', 'memory'), t('b', 'images'), t('c', 'jobs')]
  it('core only by default', () => expect(activeToolNames(reg, new Set())).toEqual(['a']))
  it('core + loaded', () => expect(activeToolNames(reg, new Set(['images']))).toEqual(['a', 'b']))
})

describe('directoryText', () => {
  const reg = [t('a', 'memory'), t('b', 'images'), t('c', 'jobs')]
  it('lists only on-demand sets present in the registry and marks loaded ones', () => {
    const txt = directoryText(reg, new Set(['images']))
    expect(txt).toContain('load_toolsets')
    expect(txt).toMatch(/- images — .*\(loaded\)/)
    expect(txt).toMatch(/- jobs — /)
    expect(txt).not.toContain('- history')
  })
  it('empty when nothing on demand', () => expect(directoryText([t('a', 'memory')], new Set())).toBe(''))
})
