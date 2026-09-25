// DB-backed — harness pattern from test/enrich-conversations.db.test.ts
//
// `active` is a frontmatter flag, not a column: listSkills({ activeOnly: true }) — what the
// `/` menu sees — honoured it, getSkill did not. So a deactivated skill vanished from the menu
// and could still be force-loaded into a prompt by name, which is not what that switch says.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { createSkill, getSkill, updateSkill, skillPath } from '../server/services/skills'
import { assembleContext } from '../server/lib/agent/assemble'
import type { MemoryDTO } from '../shared/types/memory'

const NAME = 'skill-db-test-toggle'
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

afterAll(async () => {
  await useDb().execute(sql`delete from documents where path = ${skillPath(NAME)}`)
})

describe('a deactivated skill', () => {
  it('is hidden from getSkill({ activeOnly }) and from the prompt, but still reachable for CRUD', async () => {
    await useDb().execute(sql`delete from documents where path = ${skillPath(NAME)}`)
    await createSkill({ name: NAME, description: 'Toggle probe', whenToUse: 'never', body: BODY })

    // Active: the assembler loads it.
    const live = await assembleContext({ userText: 'go', skill: NAME, budget: 4000, deps })
    expect(live.context).toContain(BODY)

    await updateSkill(NAME, { active: false })

    // Deactivated: the menu already hid it (listSkills activeOnly); now the prompt does too.
    expect(await getSkill(NAME, { activeOnly: true })).toBeNull()
    const off = await assembleContext({ userText: 'go', skill: NAME, budget: 4000, deps })
    expect(off.context).not.toContain(BODY)

    // But the CRUD paths must still see it, or updateSkill/deleteSkill would report it
    // missing and createSkill would happily write a second document at the same path.
    const raw = await getSkill(NAME)
    expect(raw?.name).toBe(NAME)
    expect(raw?.active).toBe(false)
  })
})
