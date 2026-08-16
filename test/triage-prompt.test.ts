import { describe, it, expect } from 'vitest'
import { buildTriageMessages } from '../server/lib/ai/triage'

const doc = { path: '/input/abc123.md', content: 'remind me to fix the yukon loan link' }
const projects = [
  { slug: 'finances', name: 'Finances', description: 'money' },
  { slug: '2d-rpg', name: '2D RPG', description: 'game' }
]

describe('buildTriageMessages', () => {
  it('emits a system message then a user message', () => {
    const m = buildTriageMessages(doc, projects)
    expect(m).toHaveLength(2)
    expect(m[0]!.role).toBe('system')
    expect(m[1]!.role).toBe('user')
  })

  it('names all four destinations in the system prompt', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    for (const k of ['task', 'note', 'memory', 'append']) expect(s).toContain(k)
  })

  it('injects the available project slugs', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    expect(s).toContain('finances')
    expect(s).toContain('2d-rpg')
  })

  it('instructs the model to use null when no project fits', () => {
    expect(buildTriageMessages(doc, projects)[0]!.content).toContain('null')
  })

  it('tells the model to set project null when there are no projects', () => {
    const s = buildTriageMessages(doc, [])[0]!.content
    expect(s).toContain('No projects')
  })

  it('puts the path and content in the user message', () => {
    const u = buildTriageMessages(doc, projects)[1]!.content
    expect(u).toContain('/input/abc123.md')
    expect(u).toContain('yukon loan link')
  })

  it('truncates long content to 6000 characters', () => {
    const u = buildTriageMessages({ path: '/input/x.md', content: 'y'.repeat(9000) }, projects)[1]!.content
    expect(u).toContain('y'.repeat(6000))
    expect(u).not.toContain('y'.repeat(6001))
  })

  // The filename is the whole point of the Note destination — the old enrichment
  // prompt said "keep the existing filename", which is why /input stayed unbrowsable.
  it('tells the model that a note path must include a NEW filename', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    expect(s.toLowerCase()).toContain('filename')
  })
})
