process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import { documents, agentSkills, agentConfigRevisions } from '../server/db/schema'
import { migrateSkillsFromDocuments } from '../server/services/skills'
import { splitFrontmatter } from '../shared/utils/frontmatter'

// The dev DB is shared and holds REAL skill documents: every call here passes `onlyPaths`
// so the move touches the fixtures alone.
const PATHS = ['/projects/mymind/skills/migtest-a.md', '/projects/mymind/skills/migtest-b.md']

async function cleanup() {
  const db = useDb()
  const skills = await db.select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, 'migtest-%'))
  if (skills.length) {
    await db.delete(agentConfigRevisions).where(inArray(agentConfigRevisions.targetId, skills.map(s => s.id)))
    await db.delete(agentSkills).where(inArray(agentSkills.id, skills.map(s => s.id)))
  }
  await db.delete(documents).where(inArray(documents.path, PATHS))
}
afterAll(cleanup)

describe('migrateSkillsFromDocuments', () => {
  it('moves live skill documents into agent_skills as markdown, soft-deletes them, and is idempotent', async () => {
    await cleanup()
    const db = useDb()
    await db.insert(documents).values([
      { path: PATHS[0]!, title: 'migtest-a', type: 'skill', project: 'mymind', content: 'body A',
        frontmatter: { kind: 'skill', name: 'migtest-a', description: 'd', whenToUse: 'w', active: false, source: 'agent' } },
      { path: PATHS[1]!, title: 'migtest-b', type: 'skill', project: 'mymind', content: 'body B',
        frontmatter: { kind: 'skill', name: 'migtest-b', description: 'db', whenToUse: 'wb' } }
    ])

    expect(await migrateSkillsFromDocuments({ onlyPaths: PATHS })).toBe(2)

    const rows = await db.select().from(agentSkills).where(like(agentSkills.slug, 'migtest-%'))
    const a = rows.find(r => r.slug === 'migtest-a')!
    expect(a).toMatchObject({ active: false, source: 'agent', name: 'migtest-a', description: 'd', whenToUse: 'w' })
    const parsed = splitFrontmatter(a.content)
    expect(parsed.error).toBeUndefined()
    expect(parsed.data).toEqual({ name: 'migtest-a', description: 'd', when_to_use: 'w', active: false, source: 'agent' })
    expect(parsed.body).toBe('body A')
    expect(rows.find(r => r.slug === 'migtest-b')).toMatchObject({ active: true, source: 'human' })

    const docs = await db.select().from(documents).where(inArray(documents.path, PATHS))
    expect(docs).toHaveLength(2)
    for (const d of docs) expect(d.deletedAt).not.toBeNull()

    // A system revision recorded for each moved skill.
    const revs = await db.select().from(agentConfigRevisions).where(inArray(agentConfigRevisions.targetId, rows.map(r => r.id)))
    expect(revs).toHaveLength(2)
    expect(revs.every(r => r.actor === 'system' && r.targetKind === 'skill')).toBe(true)

    // Second run: nothing new.
    expect(await migrateSkillsFromDocuments({ onlyPaths: PATHS })).toBe(0)
    expect(await db.select().from(agentSkills).where(like(agentSkills.slug, 'migtest-%'))).toHaveLength(2)
  })

  it('does not overwrite a skill whose slug already exists in agent_skills', async () => {
    await cleanup()
    const db = useDb()
    await db.insert(agentSkills).values({ slug: 'migtest-a', content: 'EXISTING', contentHash: 'h' })
    // Live doc with the same slug — the NOT EXISTS filter must skip it, and not soft-delete it.
    await db.insert(documents).values({ path: PATHS[0]!, title: 'migtest-a', type: 'skill', project: 'mymind', content: 'body A',
      frontmatter: { kind: 'skill', name: 'migtest-a', description: 'd', whenToUse: 'w' } })
    expect(await migrateSkillsFromDocuments({ onlyPaths: PATHS })).toBe(0)
    const [row] = await db.select().from(agentSkills).where(like(agentSkills.slug, 'migtest-%'))
    expect(row!.content).toBe('EXISTING')
    // …and the document it did not move stays live.
    const [doc] = await db.select().from(documents).where(inArray(documents.path, PATHS))
    expect(doc!.deletedAt).toBeNull()
  })
})
