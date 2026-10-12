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
const children = (await import('../server/api/workstreams/[id]/children.get')).default as H
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

async function fixture(state: 'running' | 'done' = 'running', tree: { parentId?: string | null; isChild?: boolean; treeBudget?: { maxSteps: number; maxWallMs: number }; createdAt?: Date } = {}) {
  const [c] = await db.insert(conversations).values({ title: `⚙ t6 ${randomUUID().slice(0, 6)}` }).returning({ id: conversations.id })
  created.conv.push(c!.id)
  const [w] = await db.insert(workstreams).values({
    conversationId: c!.id, originConversationId: null, goal: `t6 goal ${randomUUID().slice(0, 6)}`, state,
    used: { steps: 3, wallMs: 1000, inputTokens: 10, outputTokens: 5, costUsd: 0 }, toolsets: [], budget: { maxSteps: 400, maxWallMs: 7_200_000 }, ...tree
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

describe('cycle 83: children in the list and the children route', () => {
  type D = { id: string; parentId: string | null; isChild: boolean; childIds: string[]; childCount: number; state: string; createdAt: string }
  const TREE = { maxSteps: 2000, maxWallMs: 28_800_000 }

  it('`limit` counts top-level workstreams only; every embedded row is a child of a listed coordinator', async () => {
    const coord = await fixture('running', { treeBudget: TREE })
    const k1 = await fixture('running', { parentId: coord.id, isChild: true })
    const k2 = await fixture('done', { parentId: coord.id, isChild: true })
    // Scoped to this file's rows: whatever else the shared DB holds, a page of 2 has exactly 2
    // top-level rows (this file made ≥ 2), and nothing else but their children.
    const two = await list({ query: { limit: '2' } }) as D[]
    const top = two.filter(w => w.parentId === null)
    expect(top).toHaveLength(2)
    expect(two.filter(w => w.parentId !== null).every(w => top.some(t => t.id === w.parentId))).toBe(true)
    // This coordinator, wherever it sits: its children come with it and it says how many it has.
    const all = await list({ query: { limit: '100' } }) as D[]
    expect(all.find(w => w.id === coord.id)).toMatchObject({ childCount: 2, childIds: expect.arrayContaining([k1.id, k2.id]), isChild: false })
    expect(all.filter(w => w.parentId === coord.id).map(w => w.id).sort()).toEqual([k1.id, k2.id].sort())
    // A state filter applies to top-level rows; a listed coordinator still brings every child.
    const running = await list({ query: { state: 'running', limit: '100' } }) as D[]
    expect(running.map(w => w.id)).toEqual(expect.arrayContaining([coord.id, k1.id, k2.id]))
  })

  it('a coordinator with 25 children embeds 20 (still-going first, then newest) and its count; the route pages all 25', async () => {
    const coord = await fixture('running', { treeBudget: TREE })
    const t0 = Date.now() - 3_600_000
    const kids: Array<{ id: string; live: boolean }> = []
    for (let i = 0; i < 25; i++) {
      const live = i < 3   // the 3 OLDEST are still going
      const k = await fixture(live ? 'running' : 'done', { parentId: coord.id, isChild: true, createdAt: new Date(t0 + i * 1000) })
      kids.push({ id: k.id, live })
    }
    const all = await list({ query: { limit: '100' } }) as D[]
    const c = all.find(w => w.id === coord.id)!
    const embedded = all.filter(w => w.parentId === coord.id)
    expect(c.childCount).toBe(25)
    expect(embedded).toHaveLength(20)
    expect(c.childIds).toEqual(embedded.map(w => w.id))
    // Still-going first (newest of them first), then the newest ended ones.
    const want = [...kids.filter(k => k.live).reverse(), ...kids.filter(k => !k.live).reverse()].slice(0, 20).map(k => k.id)
    expect(embedded.map(w => w.id)).toEqual(want)
    expect(all.length).toBeLessThanOrEqual(100 * 21)

    const page = (q: Record<string, string>) => children({ params: { id: coord.id }, query: q }) as Promise<D[]>
    const oldestFirst = kids.map(k => k.id)
    expect((await page({ limit: '10' })).map(w => w.id)).toEqual(oldestFirst.slice(0, 10))
    expect((await page({ limit: '10', offset: '20' })).map(w => w.id)).toEqual(oldestFirst.slice(20))
    expect((await page({})).map(w => w.id)).toEqual(oldestFirst)                 // default page: up to 200
    expect((await page({ limit: '100000' })).map(w => w.id)).toEqual(oldestFirst) // clamped to 200, still all 25
    expect(await page({ limit: '0' })).toHaveLength(1)                            // at least 1
    expect((await page({ limit: 'x', offset: '-5' })).map(w => w.id)).toEqual(oldestFirst)
  })

  it('an orphaned child (its coordinator row gone) is listed on its own', async () => {
    const orphan = await fixture('running', { parentId: null, isChild: true })
    const all = await list({ query: { limit: '100' } }) as D[]
    expect(all.filter(w => w.id === orphan.id)).toHaveLength(1)
  })

  it('GET /:id/children: none for a plain workstream; 404 for a bad id', async () => {
    const plain = await fixture('running')
    expect(await children({ params: { id: plain.id }, query: {} })).toEqual([])
    await expect(children({ params: { id: 'nope' }, query: {} })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET /api/agent/worker (the offline banner)', () => {
  it('offline with no heartbeat, online with a fresh one, offline once it is > 30s old', async () => {
    expect(await worker({})).toEqual({ online: false, beatAt: null, sandbox: null })
    const boot = `t6-boot-${randomUUID().slice(0, 8)}`
    await beatWorker(boot)
    expect(await worker({})).toMatchObject({ online: true, sandbox: null })
    // Cycle 82 final review I6: the worker's sandbox preflight rides on its heartbeat.
    await beatWorker(boot, { sandbox: { ok: false, reason: 'its resource limits are not enforced on this host', checkedAt: new Date().toISOString() } })
    expect(await worker({})).toMatchObject({ online: true, sandbox: { ok: false, reason: 'its resource limits are not enforced on this host' } })
    await db.update(workerHeartbeat).set({ beatAt: sql`now() - interval '31 seconds'` }).where(eq(workerHeartbeat.bootId, boot))
    const stale = await worker({}) as { online: boolean; beatAt: string }
    expect(stale.online).toBe(false)
    expect(typeof stale.beatAt).toBe('string')
  })
})
