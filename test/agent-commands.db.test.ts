process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listCommands } from '../server/services/commands'
import { createPromptCommand } from '../server/services/prompt-commands'

afterAll(async () => {
  await useDb().execute(sql`delete from prompt_commands where name like 'cmd-test-%'`)
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
