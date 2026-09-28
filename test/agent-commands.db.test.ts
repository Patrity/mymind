process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listCommands } from '../server/services/commands'
import { createPromptCommand } from '../server/services/prompt-commands'
import { createSkill, deleteSkill, getSkill } from '../server/services/skills'

// Own the active skill these tests look for, rather than depend on the shared dev DB holding
// real ones (cycle 74 moved skills into agent_skills; a fresh DB has none until the boot move).
const SKILL = 'sktest-cmd-menu'
beforeAll(async () => {
  const prior = await getSkill(SKILL)
  if (prior) await deleteSkill(SKILL)
  await createSkill({ name: SKILL, description: 'Menu probe', whenToUse: 'Use in the command-menu test', body: 'b' })
})

afterAll(async () => {
  await useDb().execute(sql`delete from prompt_commands where name like 'cmd-test-%'`)
  const s = await getSkill(SKILL)
  if (s) {
    await deleteSkill(SKILL)
    await useDb().execute(sql`delete from agent_config_revisions where target_kind = 'skill' and target_id = ${s.id}`)
  }
})

describe('listCommands', () => {
  it('includes the code-defined client commands', async () => {
    const all = await listCommands()
    expect(all.find(c => c.name === 'clear')?.kind).toBe('client')
  })

  it('includes prompt macros from the database', async () => {
    await createPromptCommand({ name: 'cmd-test-macro', description: 'M', template: 't' })
    const all = await listCommands()
    expect(all.find(c => c.name === 'cmd-test-macro')?.kind).toBe('prompt')
  })

  it('includes every active skill as a top-level command', async () => {
    const all = await listCommands()
    const skills = all.filter(c => c.kind === 'skill')
    expect(skills.length).toBeGreaterThan(0)
    // Skill names are kebab-case (SKILL_NAME_RE), so they need no transformation.
    for (const s of skills) expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('uses whenToUse as the skill hint', async () => {
    const all = await listCommands()
    const withHint = all.filter(c => c.kind === 'skill' && c.hint)
    expect(withHint.length).toBeGreaterThan(0)
  })

  it('filters by q when given', async () => {
    await createPromptCommand({ name: 'cmd-test-zebra', description: 'Z', template: 'z' })
    const hits = await listCommands('zebra')
    expect(hits.find(c => c.name === 'cmd-test-zebra')).toBeTruthy()
    expect(hits.find(c => c.name === 'clear')).toBeUndefined()
  })

  it('returns entries sorted by name', async () => {
    const all = await listCommands()
    const names = all.map(c => c.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})
