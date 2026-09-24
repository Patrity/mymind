// DB-backed — harness pattern from test/enrich-conversations.db.test.ts
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listPromptCommands, createPromptCommand } from '../server/services/prompt-commands'

afterAll(async () => {
  await useDb().execute(sql`delete from prompt_commands where name like 'pc-test-%'`)
})

describe('prompt commands', () => {
  it('creates and lists an active command as a prompt-kind entry', async () => {
    await createPromptCommand({ name: 'pc-test-standup', description: 'Standup', template: 'What did I ship?' })
    const all = await listPromptCommands()
    const found = all.find(c => c.name === 'pc-test-standup')
    expect(found).toBeTruthy()
    expect(found!.kind).toBe('prompt')
    expect(found!.template).toBe('What did I ship?')
  })

  it('excludes inactive commands', async () => {
    const c = await createPromptCommand({ name: 'pc-test-off', description: 'Off', template: 'x' })
    await useDb().execute(sql`update prompt_commands set active = false where name = 'pc-test-off'`)
    const all = await listPromptCommands()
    expect(all.find(x => x.name === 'pc-test-off')).toBeUndefined()
    void c
  })

  it('rejects a duplicate name', async () => {
    await createPromptCommand({ name: 'pc-test-dupe', description: 'A', template: 'a' })
    await expect(createPromptCommand({ name: 'pc-test-dupe', description: 'B', template: 'b' })).rejects.toThrow()
  })

  it('rejects a reserved name', async () => {
    await expect(createPromptCommand({ name: 'clear', description: 'nope', template: 'x' })).rejects.toThrow(/reserved/i)
  })
})
