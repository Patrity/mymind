// DB-backed — harness pattern from test/agent-runs.db.test.ts.
//
// Review fix round 1, item 7: a model-registry outage must fail CLOSED on write paths (reject a
// job that pins a specific, unverifiable model) but fail OPEN on revalidateAll (never mass-
// invalidate every already-stored job that names a real model just because the registry is
// temporarily unreadable — nothing about those jobs changed).
//
// Isolated into its own file because it mocks server/lib/ai/registry/store's `loadConfig` for
// EVERY test here — safer and simpler than corrupting the real (shared, in-use) `ai_config`
// settings row in the dev DB to force a genuine load failure.
process.loadEnvFile('.env')

import { describe, it, expect, vi, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.mock('@mymind/core/lib/ai/registry/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mymind/core/lib/ai/registry/store')>()
  return {
    ...actual,
    loadConfig: async () => {
      throw new Error('registry unreachable (mocked)')
    }
  }
})

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentJobs, agentConfigRevisions } from '@mymind/core/db/schema'
import { createJob, revalidateAll, JobValidationError } from '@mymind/core/lib/agent/jobs/store'

const PREFIX = 'jstest-failopen-'

async function cleanup() {
  const db = useDb()
  const rows = await db.select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (rows.length) {
    const ids = rows.map(r => r.id)
    await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
    await db.delete(agentJobs).where(inArray(agentJobs.id, ids))
  }
}
afterAll(cleanup)

describe('model registry outage', () => {
  it('write paths fail CLOSED: a job pinning a specific model is rejected while the registry is unreadable', async () => {
    await cleanup()
    await expect(createJob({
      slug: `${PREFIX}write`,
      content: '---\ntrigger: every 10m\nmodel: some-specific-model\nenabled: false\n---\nbody\n',
      actor: 'human'
    })).rejects.toThrow(JobValidationError)
    // 'default' is unaffected either way (parse.ts never calls isKnownModel for it).
    const ok = await createJob({
      slug: `${PREFIX}write-default`,
      content: '---\ntrigger: every 10m\nmodel: default\nenabled: false\n---\nbody\n',
      actor: 'human'
    })
    expect(ok.parseError).toBeNull()
  })

  it('revalidateAll fails OPEN: an already-stored job pinning a specific model is NOT mass-invalidated by a registry outage', async () => {
    const db = useDb()
    // Inserted directly — createJob itself would reject this content (the test above), so this
    // simulates a job that was validly created BEFORE the registry went down.
    const [row] = await db.insert(agentJobs).values({
      slug: `${PREFIX}revalidate`,
      content: '---\ntrigger: every 10m\nmodel: some-specific-model\nenabled: false\n---\nbody\n',
      contentHash: 'irrelevant-for-this-test',
      source: 'human',
      enabled: false,
      triggerKind: 'every',
      triggerExpr: '10m',
      timezone: 'UTC',
      parseError: null
    }).returning()

    const changed = await revalidateAll({ onlyIds: [row!.id], mainConversationId: '00000000-0000-0000-0000-000000000000' })
    expect(changed).toBe(0)
    const [after] = await db.select().from(agentJobs).where(eq(agentJobs.id, row!.id))
    expect(after!.parseError).toBeNull()
  })
})
