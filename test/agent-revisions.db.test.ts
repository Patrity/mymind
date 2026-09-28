process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentConfigRevisions } from '../server/db/schema'
import { recordRevision, listRevisions, getRevision, REVISIONS_KEPT } from '../server/lib/agent/config/revisions'

// A target id no real skill/job has — revisions carry no FK, so a random uuid scopes the test.
const TARGET = randomUUID()
afterAll(async () => {
  await useDb().delete(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, TARGET)))
})

describe('agent config revisions', () => {
  it(`keeps only the newest ${REVISIONS_KEPT} revisions per target`, async () => {
    expect(REVISIONS_KEPT).toBe(100)
    for (let i = 0; i < 105; i++) {
      await recordRevision({ targetKind: 'job', targetId: TARGET, content: `rev-${i}`, actor: i % 2 ? 'agent' : 'human' })
    }
    const rows = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, TARGET)))
    expect(rows).toHaveLength(100)
    const kept = new Set(rows.map(r => r.content))
    for (let i = 0; i < 5; i++) expect(kept.has(`rev-${i}`)).toBe(false)
    for (let i = 5; i < 105; i++) expect(kept.has(`rev-${i}`)).toBe(true)

    // listRevisions is newest-first and honours its limit; getRevision round-trips one.
    const listed = await listRevisions('job', TARGET, 3)
    expect(listed.map(r => r.content)).toEqual(['rev-104', 'rev-103', 'rev-102'])
    expect(listed[0]!.actor).toBe('human')
    const one = await getRevision(listed[1]!.id)
    expect(one).toMatchObject({ targetKind: 'job', targetId: TARGET, content: 'rev-103' })
    expect(await getRevision(randomUUID())).toBeNull()
  })
})
