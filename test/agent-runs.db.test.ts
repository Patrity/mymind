process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '@mymind/core/db'
import { conversations, agentRuns } from '@mymind/core/db/schema'
import { createRun, claimNextRun, finishRun, activeRunFor, recoverOrphans, touchRun } from '@mymind/core/lib/agent/runtime/runs'
import { eq, inArray, sql } from 'drizzle-orm'

const convIds: string[] = []
async function conv(title: string) {
  const [c] = await useDb().insert(conversations).values({ title: `RUNS-TEST ${title}` }).returning()
  convIds.push(c!.id)
  return c!.id
}
const input = { text: 'hello', modality: 'text' as const }
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('run store', () => {
  it('claims the oldest queued run and marks it running', async () => {
    const c = await conv('claim')
    const a = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    const got = await claimNextRun({ onlyConversations: [c] })
    expect(got?.id).toBe(a.id)
    expect(got?.status).toBe('running')
    expect(got?.claimedAt).toBeTruthy()
  })

  it('will not claim a second run on a conversation that already has one running', async () => {
    const c = await conv('serial')
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    expect(await claimNextRun({ onlyConversations: [c] })).not.toBeNull()
    expect(await claimNextRun({ onlyConversations: [c] })).toBeNull()
  })

  it('two concurrent claimers on one conversation never both win', async () => {
    const c = await conv('race')
    for (let i = 0; i < 4; i++) await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    const results = await Promise.all([1, 2, 3, 4].map(() => claimNextRun({ onlyConversations: [c] })))
    expect(results.filter(Boolean)).toHaveLength(1)
    const running = await useDb().select().from(agentRuns).where(sql`${agentRuns.conversationId} = ${c} and ${agentRuns.status} = 'running'`)
    expect(running).toHaveLength(1)
  })

  it('respects the headless slot cap across conversations', async () => {
    const c1 = await conv('headless-1'); const c2 = await conv('headless-2')
    await createRun({ conversationId: c1, sessionKey: 'isolated:a', trigger: 'wake', profile: 'headless', input })
    await createRun({ conversationId: c2, sessionKey: 'isolated:b', trigger: 'wake', profile: 'headless', input })
    expect(await claimNextRun({ headlessSlots: 1, onlyConversations: [c1, c2] })).not.toBeNull()
    expect(await claimNextRun({ headlessSlots: 1, onlyConversations: [c1, c2] })).toBeNull()
  })

  it('finishRun records the outcome and frees the conversation', async () => {
    const c = await conv('finish')
    const r = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c] })
    await finishRun(r.id, { status: 'done', suppressed: true })
    expect(await activeRunFor(c)).toBeNull()
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.id))
    expect(row!.status).toBe('done')
    expect(row!.suppressed).toBe(true)
    expect(row!.finishedAt).toBeTruthy()
  })

  it('touchRun is fenced to status=running: bumps aliveAt while running, reports false once the run has moved on', async () => {
    const c = await conv('touch-fence')
    const r = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c] })
    expect(await touchRun(r.id)).toBe(true)
    await finishRun(r.id, { status: 'done' })
    // The row has moved on ('done'); a stray liveness bump (e.g. an alive-interval callback
    // that fired just after finishRun committed) must not match it, let alone resurrect it.
    expect(await touchRun(r.id)).toBe(false)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.id))
    expect(row!.status).toBe('done')
  })

  it('finishRun is fenced to status=running: never overwrites a run recovery already marked interrupted', async () => {
    const c = await conv('finish-fence')
    const r = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c] })
    // Simulate another process's recovery pass winning the race: the row is 'interrupted'
    // before this process's own finishRun call lands. Backdate aliveAt (never staleMs:0 —
    // the dev DB is shared) so recoverOrphans's real 60s threshold sees it as stale.
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.id))
    await recoverOrphans({ onlyConversations: [c] })
    await finishRun(r.id, { status: 'done', usage: { totalTokens: 7 } })
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.id))
    expect(row!.status).toBe('interrupted') // finishRun's write was fenced out, not applied
    expect(row!.usage).toBeNull()
  })

  it('recoverOrphans marks stale running rows interrupted and leaves fresh ones alone', async () => {
    const c1 = await conv('stale'); const c2 = await conv('fresh')
    const stale = await createRun({ conversationId: c1, sessionKey: `thread:${c1}`, trigger: 'user', profile: 'interactive', input })
    const fresh = await createRun({ conversationId: c2, sessionKey: `thread:${c2}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c1] }); await claimNextRun({ onlyConversations: [c2] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, stale.id))
    await touchRun(fresh.id)
    const recovered = await recoverOrphans({ onlyConversations: [c1, c2] })
    expect(recovered.map(r => r.id)).toEqual([stale.id])
    const [s] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, stale.id))
    const [f] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, fresh.id))
    expect(s!.status).toBe('interrupted')
    expect(f!.status).toBe('running')
  })
})
