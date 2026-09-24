// test/memory-applicability.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only
// exists inside the Nuxt/Nitro runtime (see test/triage-actuators.db.test.ts for the same
// note). Stub it to a fixed vector so this suite never depends on a homelab embeddings rig.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { createMemory, listMemories } from '../server/services/memory'
import { sql } from 'drizzle-orm'

describe('memory applicability', () => {
  beforeEach(async () => {
    await useDb().execute(sql`delete from memories where content like 'APPLIC-TEST%'`)
  })

  it('defaults to project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST default', project: 'alpha' })
    expect(m.applicability).toBe('project')
  })

  it('hides a project-scoped memory from another project', async () => {
    await createMemory({ scope: 'user', content: 'APPLIC-TEST alpha-only', project: 'alpha' })
    const found = await listMemories({ project: 'beta', limit: 100 })
    expect(found.some(m => m.content === 'APPLIC-TEST alpha-only')).toBe(false)
  })

  it('shows a GLOBAL memory when querying a different project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST travels', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: 'beta', limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST travels')).toBe(true)
  })

  it('still shows a global memory when querying its own project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST own', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: 'alpha', limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST own')).toBe(true)
  })

  it('project:null still means "memories with no project", not "global"', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST nulled', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: null, limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST nulled')).toBe(false)
  })
})
