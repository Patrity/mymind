// DB-backed — harness pattern from test/enrich-conversations.db.test.ts
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { listPromptCommands, createPromptCommand } from '../server/services/prompt-commands'

afterAll(async () => {
  // 'clear' is named explicitly (outside the pc-test- prefix by design): it's the
  // RESERVED name the reserved-name test deliberately attempts. Normally the guard
  // rejects it and nothing is ever written — but if that guard regresses, the insert
  // succeeds and orphans a row under a name this cleanup would otherwise miss.
  // Deliberately loose: `%pc-test%` rather than `pc-test-%` (a regressed trim stores a name
  // with leading whitespace a prefix pattern never matches) and `lower(...)` (a regressed
  // shape check lets `Clear` / `PC-Test-…` through). Every guard these tests exercise fails
  // by WRITING a row, so the cleanup has to cover the shapes it would write.
  await useDb().execute(
    sql`delete from prompt_commands where lower(name) like '%pc-test%' or lower(trim(name)) = 'clear'`
  )
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
    await createPromptCommand({ name: 'pc-test-on', description: 'On', template: 'y' })
    await useDb().execute(sql`update prompt_commands set active = false where name = 'pc-test-off'`)
    const all = await listPromptCommands()
    expect(all.find(x => x.name === 'pc-test-off')).toBeUndefined()
    expect(all.find(x => x.name === 'pc-test-on')).toBeTruthy()
    void c
  })

  it('rejects a duplicate name', async () => {
    await createPromptCommand({ name: 'pc-test-dupe', description: 'A', template: 'a' })
    await expect(createPromptCommand({ name: 'pc-test-dupe', description: 'B', template: 'b' })).rejects.toThrow()
  })

  it('rejects a reserved name', async () => {
    await expect(createPromptCommand({ name: 'clear', description: 'nope', template: 'x' })).rejects.toThrow(/reserved/i)
  })

  it('rejects a PADDED reserved name', async () => {
    // The guard read the raw name, and the raw name was also what got stored — so `' clear '`
    // produced a row the composer's `^\/([^\s]+)` can never match. A dead row, not a shadow.
    await expect(createPromptCommand({ name: ' clear ', description: 'nope', template: 'x' })).rejects.toThrow(/reserved/i)
    const rows = await useDb().execute(sql`select name from prompt_commands where trim(name) = 'clear'`)
    expect(rows.rows.length).toBe(0)
  })

  it('rejects a name with whitespace in it', async () => {
    // parseCommand stops at the first whitespace, so `daily standup` is permanently
    // unreachable from `/`. Skills got SKILL_NAME_RE; macros got nothing.
    await expect(createPromptCommand({ name: 'pc-test daily standup', description: 'D', template: 't' }))
      .rejects.toThrow(/kebab-case/i)
  })

  it('rejects an uppercase name', async () => {
    // mergeCommands keys precedence on the exact string while the menu filters
    // case-insensitively, so `Clear` would dodge the built-in and sit beside it under `/cl`.
    await expect(createPromptCommand({ name: 'Clear', description: 'C', template: 't' }))
      .rejects.toThrow(/kebab-case/i)
    await expect(createPromptCommand({ name: 'PC-Test-Shouty', description: 'S', template: 't' }))
      .rejects.toThrow(/kebab-case/i)
  })

  it('rejects an empty template', async () => {
    // The column is notNull but '' satisfies it, and an empty template makes the composer
    // send the literal "/name" to the model.
    await expect(createPromptCommand({ name: 'pc-test-empty', description: 'E', template: '' }))
      .rejects.toThrow(/template/i)
    await expect(createPromptCommand({ name: 'pc-test-blank', description: 'B', template: '   \n' }))
      .rejects.toThrow(/template/i)
  })

  it('stores a padded name trimmed, so the composer can match it', async () => {
    const created = await createPromptCommand({ name: '  pc-test-padded  ', description: 'P', template: '  t  ' })
    expect(created.name).toBe('pc-test-padded')
    expect(created.template).toBe('t')
    const all = await listPromptCommands()
    expect(all.find(c => c.name === 'pc-test-padded')).toBeTruthy()
  })
})
