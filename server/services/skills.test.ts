import { describe, it, expect } from 'vitest'
import { validateSkill, skillPath, docToSkill, SKILL_BODY_MAX } from './skills'

const good = { name: 'db-maintenance', description: 'Safe DB ops', whenToUse: 'Use when touching Postgres', body: 'Do this.' }

describe('validateSkill', () => {
  it('accepts a well-formed skill', () => {
    expect(validateSkill(good)).toEqual({ ok: true })
  })
  it.each([
    ['DbMaintenance', /kebab-case/i],
    ['db_maintenance', /kebab-case/i],
    ['', /name/i],
    ['-leading', /kebab-case/i]
  ])('rejects bad name %s', (name, re) => {
    const r = validateSkill({ ...good, name })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(re)
  })
  it('rejects empty description, whenToUse, body', () => {
    for (const k of ['description', 'whenToUse', 'body'] as const) {
      const r = validateSkill({ ...good, [k]: '   ' })
      expect(r.ok, k).toBe(false)
    }
  })
  it('rejects an oversize body', () => {
    const r = validateSkill({ ...good, body: 'x'.repeat(SKILL_BODY_MAX + 1) })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/too long|cap|20000/i)
  })
})

describe('skillPath', () => {
  it('files skills under the reserved path', () => {
    expect(skillPath('db-maintenance')).toBe('/projects/mymind/skills/db-maintenance.md')
  })
})

describe('docToSkill', () => {
  const row = { id: 'i1', content: 'BODY', updatedAt: new Date('2026-07-24T00:00:00Z'), frontmatter: { kind: 'skill', name: 'db-maintenance', description: 'd', whenToUse: 'w', active: true, source: 'agent' } }
  it('maps a skill document to a Skill', () => {
    expect(docToSkill(row)).toEqual({ id: 'i1', name: 'db-maintenance', description: 'd', whenToUse: 'w', active: true, source: 'agent', body: 'BODY', updatedAt: '2026-07-24T00:00:00.000Z' })
  })
  it('returns null when frontmatter is not a skill', () => {
    expect(docToSkill({ ...row, frontmatter: { kind: 'note' } })).toBeNull()
  })
  it('defaults active=true and source=human when absent', () => {
    const s = docToSkill({ ...row, frontmatter: { kind: 'skill', name: 'x', description: 'd', whenToUse: 'w' } })
    expect(s).toMatchObject({ active: true, source: 'human' })
  })
})
