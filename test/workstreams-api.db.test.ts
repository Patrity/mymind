// Cycle 81 Task 6 — the /api/workstreams reads and the worker heartbeat the offline banner reads,
// against the real (shared dev) DB. Rows are this file's own (a conversation + a workstream with no
// segment, so no worker ever runs it) and are deleted afterwards; heartbeats go to a private bus
// namespace so the dev worker's beat is never seen nor touched.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])
vi.stubGlobal('getQuery', (e: { query?: Record<string, string> }) => e.query ?? {})

const { eq, sql } = await import('drizzle-orm')
const { useDb } = await import('@mymind/core/db')
const { conversations, workstreams, workerHeartbeat } = await import('@mymind/core/db/schema')
const { setBusNs } = await import('@mymind/core/lib/bus/ns')
const { beatWorker } = await import('@mymind/core/lib/bus/commands')
type H = (e: unknown) => Promise<unknown>
const list = (await import('../server/api/workstreams/index.get')).default as H
const detail = (await import('../server/api/workstreams/[id].get')).default as H
const worker = (await import('../server/api/agent/worker.get')).default as H

const NS = `t6-${randomUUID().slice(0, 8)}`
setBusNs(NS)
const db = useDb()
const created: { conv: string[]; ws: string[] } = { conv: [], ws: [] }

afterAll(async () => {
  for (const id of created.ws) await db.delete(workstreams).where(eq(workstreams.id, id))
  for (const id of created.conv) await db.delete(conversations).where(eq(conversations.id, id))
  await db.delete(workerHeartbeat).where(eq(workerHeartbeat.ns, NS))
  setBusNs(null)
})

async function fixture(state: 'running' | 'done' = 'running') {
  const [c] = await db.insert(conversations).values({ title: `⚙ t6 ${randomUUID().slice(0, 6)}` }).returning({ id: conversations.id })
  created.conv.push(c!.id)
  const [w] = await db.insert(workstreams).values({
    conversationId: c!.id, originConversationId: null, goal: `t6 goal ${randomUUID().slice(0, 6)}`, state,
    used: { steps: 3, wallMs: 1000, inputTokens: 10, outputTokens: 5, costUsd: 0 }, toolsets: [], budget: { maxSteps: 400, maxWallMs: 7_200_000 }
  }).returning()
  created.ws.push(w!.id)
  return w!
}

describe('GET /api/workstreams + /:id', () => {
  it('lists DTOs (newest first) and filters by state', async () => {
    const a = await fixture('running')
    const b = await fixture('done')
    const all = await list({ query: { limit: '200' } }) as Array<{ id: string; used: { steps: number }; budget: { maxSteps: number } }>
    const ids = all.map(w => w.id)
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id))
    expect(all.find(w => w.id === a.id)).toMatchObject({ used: { steps: 3 }, budget: { maxSteps: 400 } })
    const done = await list({ query: { state: 'done,bogus', limit: '200' } }) as Array<{ id: string; state: string }>
    expect(done.every(w => w.state === 'done')).toBe(true)
    expect(done.map(w => w.id)).toContain(b.id)
    expect(done.map(w => w.id)).not.toContain(a.id)
  })
  it('detail returns one; unknown and malformed ids are 404s', async () => {
    const a = await fixture()
    expect(await detail({ params: { id: a.id } })).toMatchObject({ id: a.id, goal: a.goal, state: 'running', conversationId: a.conversationId })
    await expect(detail({ params: { id: randomUUID() } })).rejects.toMatchObject({ statusCode: 404 })
    await expect(detail({ params: { id: 'not-a-uuid' } })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET /api/agent/worker (the offline banner)', () => {
  it('offline with no heartbeat, online with a fresh one, offline once it is > 30s old', async () => {
    expect(await worker({})).toEqual({ online: false, beatAt: null })
    const boot = `t6-boot-${randomUUID().slice(0, 8)}`
    await beatWorker(boot)
    expect(await worker({})).toMatchObject({ online: true })
    await db.update(workerHeartbeat).set({ beatAt: sql`now() - interval '31 seconds'` }).where(eq(workerHeartbeat.bootId, boot))
    const stale = await worker({}) as { online: boolean; beatAt: string }
    expect(stale.online).toBe(false)
    expect(typeof stale.beatAt).toBe('string')
  })
})
