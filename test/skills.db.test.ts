// DB-backed — harness pattern from test/agent-runs.db.test.ts
//
// Cycle 74: skills live in agent_skills as markdown-with-frontmatter. The service API is the
// same as when they were documents, so these tests pin behaviour, not storage.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentSkills, agentConfigRevisions } from '@mymind/core/db/schema'
import {
  createSkill, getSkill, updateSkill, deleteSkill, listSkills,
  getSkillSource, saveSkillSource, listSkillRevisions, revertSkill, restoreSkill, ConflictError
} from '@mymind/core/services/skills'
import { assembleContext } from '@mymind/core/lib/agent/assemble'
import { splitFrontmatter } from '@mymind/core/shared/utils/frontmatter'
import type { MemoryDTO } from '@mymind/core/shared/types/memory'

const PREFIX = 'sktest-'
const NAME = `${PREFIX}toggle`
const BODY = 'STEP ONE: run the toggle probe.'

// Everything except the skill lookup is stubbed — the point is to exercise the REAL
// getSkill path that assembleContext uses by default.
const deps = {
  listResident: async () => [] as MemoryDTO[],
  search: async () => [] as MemoryDTO[],
  liveContext: async () => '',
  summary: async () => null as string | null,
  recordRetrievals: async () => {}
}

async function cleanup() {
  const db = useDb()
  // Revisions outlive a deleted skill (no FK), so a slug lookup can't find every fixture's
  // history — match the fixture markdown itself (every one starts with `name: sktest-`).
  await db.execute(sql`delete from agent_config_revisions where target_kind = 'skill' and content like ${'---\nname: ' + PREFIX + '%'}`)
  const rows = await db.select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${PREFIX}%`))
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'skill'), inArray(agentConfigRevisions.targetId, ids)))
  await db.delete(agentSkills).where(inArray(agentSkills.id, ids))
}
afterAll(cleanup)

describe('skill CRUD', () => {
  it('creates, reads, lists, renames and deletes through the same API', async () => {
    await cleanup()
    const s = await createSkill({ name: `${PREFIX}crud`, description: ' Desc ', whenToUse: 'When', body: 'Body text' })
    expect(s).toMatchObject({ name: `${PREFIX}crud`, description: 'Desc', whenToUse: 'When', body: 'Body text', active: true, source: 'human' })
    await expect(createSkill({ name: `${PREFIX}crud`, description: 'd', whenToUse: 'w', body: 'b' })).rejects.toThrow(/already exists/)

    // Markdown is the source of truth: snake_case when_to_use in frontmatter, body after it.
    const src = await getSkillSource(`${PREFIX}crud`)
    const parsed = splitFrontmatter(src!.content)
    expect(parsed.data).toEqual({ name: `${PREFIX}crud`, description: 'Desc', when_to_use: 'When', active: true, source: 'human' })
    expect(parsed.body).toBe('Body text')

    expect((await listSkills()).some(x => x.name === `${PREFIX}crud`)).toBe(true)

    const renamed = await updateSkill(`${PREFIX}crud`, { name: `${PREFIX}crud2`, body: 'New body' })
    expect(renamed).toMatchObject({ id: s.id, name: `${PREFIX}crud2`, body: 'New body', description: 'Desc' })
    expect(await getSkill(`${PREFIX}crud`)).toBeNull()
    expect(await updateSkill(`${PREFIX}nope`, { body: 'x' })).toBeNull()
    await expect(updateSkill(`${PREFIX}crud2`, { body: '' })).rejects.toThrow(/body is required/)

    expect(await deleteSkill(`${PREFIX}crud2`)).toBe(true)
    expect(await getSkill(`${PREFIX}crud2`)).toBeNull()
    expect(await deleteSkill(`${PREFIX}crud2`)).toBe(false)
  })
})

describe('a deactivated skill', () => {
  it('is hidden from getSkill({ activeOnly }) and from the prompt, but still reachable for CRUD', async () => {
    await createSkill({ name: NAME, description: 'Toggle probe', whenToUse: 'never', body: BODY })

    // Active: getSkill({activeOnly}) — the slash-command tier path — returns the body, and the
    // assembler loads it.
    expect((await getSkill(NAME, { activeOnly: true }))?.body).toBe(BODY)
    const live = await assembleContext({ userText: 'go', skill: NAME, budget: 4000, deps })
    expect(live.context).toContain(BODY)

    await updateSkill(NAME, { active: false })

    expect(await getSkill(NAME, { activeOnly: true })).toBeNull()
    expect((await listSkills({ activeOnly: true })).some(x => x.name === NAME)).toBe(false)
    const off = await assembleContext({ userText: 'go', skill: NAME, budget: 4000, deps })
    expect(off.context).not.toContain(BODY)

    // But the CRUD paths must still see it.
    const raw = await getSkill(NAME)
    expect(raw?.name).toBe(NAME)
    expect(raw?.active).toBe(false)
  })
})

describe('skill source editing', () => {
  it('rejects a save against a stale hash with ConflictError carrying the current content', async () => {
    await createSkill({ name: `${PREFIX}cas`, description: 'd', whenToUse: 'w', body: 'v1' })
    const src = await getSkillSource(`${PREFIX}cas`)
    const next = src!.content.replace('v1', 'v2')
    const saved = await saveSkillSource(`${PREFIX}cas`, next, src!.contentHash, 'human')
    expect(saved.content).toBe(next)
    expect(saved.contentHash).not.toBe(src!.contentHash)
    expect((await getSkill(`${PREFIX}cas`))?.body).toBe('v2')

    // A second writer still holding the ORIGINAL hash loses.
    const err = await saveSkillSource(`${PREFIX}cas`, src!.content.replace('v1', 'v3'), src!.contentHash, 'agent')
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).current).toEqual({ content: next, contentHash: saved.contentHash })
    expect((await getSkill(`${PREFIX}cas`))?.body).toBe('v2')
  })

  it('validates the source and updates the derived columns', async () => {
    await createSkill({ name: `${PREFIX}val`, description: 'd', whenToUse: 'w', body: 'b' })
    const src = await getSkillSource(`${PREFIX}val`)
    await expect(saveSkillSource(`${PREFIX}val`, src!.content.replace('description: d', 'description: ""'), src!.contentHash, 'human'))
      .rejects.toThrow(/description is required/)
    const saved = await saveSkillSource(`${PREFIX}val`, src!.content.replace('active: true', 'active: false'), src!.contentHash, 'human')
    expect(saved.active).toBe(false)
    const [row] = await useDb().select().from(agentSkills).where(eq(agentSkills.slug, `${PREFIX}val`))
    expect(row!.active).toBe(false)
  })

  it('writes a revision with its actor on every save, and reverts to one', async () => {
    const s = await createSkill({ name: `${PREFIX}rev`, description: 'd', whenToUse: 'w', body: 'first' })
    const src = await getSkillSource(`${PREFIX}rev`)
    await saveSkillSource(`${PREFIX}rev`, src!.content.replace('first', 'second'), src!.contentHash, 'agent')

    const revs = await listSkillRevisions(`${PREFIX}rev`)
    expect(revs.map(r => r.actor)).toEqual(['agent', 'human'])
    expect(revs[0]!.content).toContain('second')
    const dbRevs = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'skill'), eq(agentConfigRevisions.targetId, s.id)))
    expect(dbRevs).toHaveLength(2)

    const reverted = await revertSkill(`${PREFIX}rev`, revs[1]!.id, 'human')
    expect(reverted.content).toBe(src!.content)
    expect((await getSkill(`${PREFIX}rev`))?.body).toBe('first')
    expect((await listSkillRevisions(`${PREFIX}rev`))).toHaveLength(3)
  })

  it('treats a null expectedHash as create-only: it creates, but never overwrites an existing skill', async () => {
    const md = `---\nname: ${PREFIX}new\ndescription: d\nwhen_to_use: w\nactive: true\nsource: human\n---\nfresh`
    const created = await saveSkillSource(`${PREFIX}new`, md, null, 'human')
    expect((await getSkill(`${PREFIX}new`))?.body).toBe('fresh')

    const err = await saveSkillSource(`${PREFIX}new`, md.replace('fresh', 'clobber'), null, 'human')
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).current).toEqual({ content: created.content, contentHash: created.contentHash })
    expect((await getSkill(`${PREFIX}new`))?.body).toBe('fresh')
  })
})

describe('delete and restore', () => {
  it('records the delete as a revision, and restoreSkill brings the skill back under the SAME id with its full history', async () => {
    const s = await createSkill({ name: `${PREFIX}del`, description: 'd', whenToUse: 'w', body: 'one' })
    await updateSkill(`${PREFIX}del`, { body: 'two' }, { actor: 'agent' })
    const before = await getSkillSource(`${PREFIX}del`)

    expect(await deleteSkill(`${PREFIX}del`, { actor: 'agent' })).toBe(true)
    const afterDelete = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'skill'), eq(agentConfigRevisions.targetId, s.id)))
    expect(afterDelete).toHaveLength(3) // create, update, delete
    expect(afterDelete.some(r => r.actor === 'agent' && r.content === before!.content)).toBe(true)

    const restored = await restoreSkill(before!.id, before!.content, 'agent')
    expect(restored.id).toBe(s.id)
    expect((await getSkill(`${PREFIX}del`))).toMatchObject({ id: s.id, body: 'two' })
    const revs = await listSkillRevisions(`${PREFIX}del`)
    expect(revs).toHaveLength(4)
    expect(revs.map(r => r.actor)).toEqual(['agent', 'agent', 'agent', 'human'])

    // Restoring over a live skill is refused.
    await expect(restoreSkill(before!.id, before!.content, 'agent')).rejects.toThrow(/already exists/)
  })
})

describe('the active toggle (final review M8)', () => {
  it('flips only the `active:` line of the stored markdown, keeping extra keys and formatting', async () => {
    const name = `${PREFIX}m8-toggle`
    const content = `---\nname: ${name}\ndescription:   Spaced desc   # a comment\nwhen_to_use: w\nactive: true\nsource: human\nextra_key: keep me\n---\nBody with  two  spaces.\n`
    await saveSkillSource(name, content, null, 'human')
    await updateSkill(name, { active: false }, { actor: 'human' })
    const src = await getSkillSource(name)
    expect(src!.content).toBe(content.replace('active: true', 'active: false'))
    expect((await getSkill(name))!.active).toBe(false)
    // Any other change still regenerates from fields (the extra key is not a field).
    await updateSkill(name, { active: true, body: 'New body' }, { actor: 'human' })
    expect((await getSkillSource(name))!.content).not.toContain('extra_key')
  })
})
