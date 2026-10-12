// Cycle 83 Task 1 — per-model in-flight pools in the claim path (runtime/pools.ts, runs.ts
// claimNextRun). The pool is the count of RUNNING workstream segments per primary model id, read at
// every claim. The dev DB is shared: every model id here is unique to this run, so no other
// session's segments can count toward these pools, and every claim is scoped to this file's
// conversations.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentRuns, conversations, workspaces, workstreams, type AgentRun } from '@mymind/core/db/schema'
import { claimNextRun, createRun, finishRun, recoverOrphans } from '@mymind/core/lib/agent/runtime/runs'
import { _executeClaimedForTests, setExecutionMode } from '@mymind/core/lib/agent/runtime/queue'
import { segmentPrimaryModelId } from '@mymind/core/lib/agent/runtime/pools'
import { startWorkstream } from '@mymind/core/lib/agent/workstreams/loop'
import { loadConfig } from '@mymind/core/lib/ai/registry/store'
import { DEFAULT_MAX_IN_FLIGHT } from '@mymind/core/lib/ai/registry/types'
import { resolveChainFrom } from '@mymind/core/lib/ai/registry/resolve'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import type { RunOutcome } from '@mymind/core/lib/agent/runtime/types'

const NS = `t83-pools-${process.pid}`
const tag = randomUUID().slice(0, 8)
const model = (n: string) => `pool-test-${tag}-${n}`
const convIds: string[] = []
const input = { text: 'segment', modality: 'text' as const }

beforeAll(() => { setBusNs(NS); setExecutionMode('remote') })
afterAll(async () => {
  const db = useDb()
  await db.delete(workspaces).where(eq(workspaces.ns, NS))
  if (convIds.length) {
    await db.delete(workstreams).where(inArray(workstreams.conversationId, convIds))
    await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
    await db.delete(conversations).where(inArray(conversations.id, convIds))
  }
  setExecutionMode('local')
  setBusNs(null)
  await closeListener()
})

async function conv(): Promise<string> {
  const [c] = await useDb().insert(conversations).values({ title: `POOLS-TEST ${tag}` }).returning()
  convIds.push(c!.id)
  return c!.id
}
/** One queued workstream segment on its own conversation (the unique index allows one per thread). */
async function segment(modelDefId: string | null): Promise<AgentRun> {
  const c = await conv()
  return createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', kind: 'workstream', input, modelDefId })
}
async function turn(modelDefId: string): Promise<AgentRun> {
  const c = await conv()
  return createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input, modelDefId })
}
const claim = (scope: AgentRun[], poolLimits: Record<string, number>) =>
  claimNextRun({ onlyConversations: scope.map(r => r.conversationId), poolLimits })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('per-model in-flight pools', () => {
  it('the N+1th segment on a model stays queued; when one ends the OLDEST waiting one gets the slot (FIFO)', async () => {
    const X = model('fifo')
    const limits = { [X]: 2 }
    const a = await segment(X); await sleep(5)
    const b = await segment(X); await sleep(5)
    const c = await segment(X); await sleep(5)
    const d = await segment(X)
    const all = [a, b, c, d]
    expect((await claim(all, limits))?.id).toBe(a.id)
    expect((await claim(all, limits))?.id).toBe(b.id)
    expect(await claim(all, limits)).toBeNull()
    const [cRow] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, c.id))
    expect(cRow!.status).toBe('queued')
    await finishRun(a.id, { status: 'done' })
    expect((await claim(all, limits))?.id).toBe(c.id)
    expect(await claim(all, limits)).toBeNull()
  })

  it('pools are per model: a full pool on X never holds back a segment on Y', async () => {
    const X = model('x'); const Y = model('y')
    const x1 = await segment(X); const x2 = await segment(X); const y1 = await segment(Y)
    const all = [x1, x2, y1]
    const limits = { [X]: 1, [Y]: 1 }
    const got = [await claim(all, limits), await claim(all, limits), await claim(all, limits)].map(r => r?.id ?? null)
    expect(got).toEqual([x1.id, y1.id, null])
  })

  it.each(['done', 'failed', 'aborted'] as const)('the slot is released when the segment ends %s', async (status) => {
    const X = model(`release-${status}`)
    const a = await segment(X); const b = await segment(X)
    const limits = { [X]: 1 }
    expect((await claim([a, b], limits))?.id).toBe(a.id)
    expect(await claim([a, b], limits)).toBeNull()
    await finishRun(a.id, { status } as RunOutcome)
    expect((await claim([a, b], limits))?.id).toBe(b.id)
  })

  it('the slot is released when recovery interrupts the segment (stale, or a dead boot\'s on an exclusive restart)', async () => {
    const X = model('interrupt')
    const a = await segment(X); const b = await segment(X); const c = await segment(X)
    const limits = { [X]: 1 }
    expect((await claim([a, b, c], limits))?.id).toBe(a.id)
    await recoverOrphans({ staleMs: 0, onlyConversations: [a.conversationId] })
    expect((await useDb().select().from(agentRuns).where(eq(agentRuns.id, a.id)))[0]!.status).toBe('interrupted')
    expect((await claim([a, b, c], limits))?.id).toBe(b.id)
    // A worker restart: the running row belongs to a boot that is gone. The pool is the DB rows, so
    // it still counts — until recovery takes it over, and then the slot is free again.
    await useDb().update(agentRuns).set({ owner: randomUUID() }).where(eq(agentRuns.id, b.id))
    expect(await claim([a, b, c], limits)).toBeNull()
    await recoverOrphans({ takeoverForeign: true, onlyConversations: [b.conversationId] })
    expect((await claim([a, b, c], limits))?.id).toBe(c.id)
  })

  it('chat turns are never pooled, even on a model whose pool is full', async () => {
    const X = model('chat')
    const s1 = await segment(X); const t1 = await turn(X); const s2 = await segment(X)
    const limits = { [X]: 1 }
    expect((await claim([s1], limits))?.id).toBe(s1.id)
    expect((await claim([t1, s2], limits))?.id).toBe(t1.id)
    expect(await claim([s2], limits)).toBeNull()
  })

  it('a model missing from the limits gets the default size; a segment with no model is not pooled', async () => {
    const X = model('default')
    const segs: AgentRun[] = []
    for (let i = 0; i < DEFAULT_MAX_IN_FLIGHT + 1; i++) segs.push(await segment(X))
    let claimed = 0
    while (await claim(segs, {})) claimed++
    expect(claimed).toBe(DEFAULT_MAX_IN_FLIGHT)
    const free = [await segment(null), await segment(null)]
    expect(await claim(free, {})).not.toBeNull()
    expect(await claim(free, {})).not.toBeNull()
  })

  it('two claimers held at the same point can never both take the last slot (the claim lock serialises them)', async () => {
    // Deterministic, not a race: each claimer, after picking its row and BEFORE marking it running,
    // waits at a barrier for the other (up to 1.5 s). Without the claim lock both get there, both
    // read "1 slot free", and both commit → 2 running in a pool of 1. With the lock the second
    // claimer is still waiting on the lock, so the first times out of the barrier and commits; the
    // second then reads the committed count and claims nothing.
    const X = model('race')
    const segs = [await segment(X), await segment(X)]
    const limits = { [X]: 1 }
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((r) => { release = r })
    const barrier = async () => {
      if (++arrived === 2) release()
      await Promise.race([both, sleep(1500)])
    }
    const got = await Promise.all(segs.map(() =>
      claimNextRun({ onlyConversations: segs.map(r => r.conversationId), poolLimits: limits, _afterPick: barrier })))
    expect(arrived).toBe(1)
    expect(got.filter(Boolean)).toHaveLength(1)
    const running = await useDb().select().from(agentRuns)
      .where(and(inArray(agentRuns.conversationId, segs.map(s => s.conversationId)), eq(agentRuns.status, 'running')))
    expect(running).toHaveLength(1)
  })

  it('failing over mid-segment takes no second slot: the pool key stays the primary model', async () => {
    const X = model('primary'); const Y = model('fallback')
    const x = await segment(X); const y = await segment(Y)
    const limits = { [X]: 1, [Y]: 1 }
    const run = await claim([x], limits)
    expect(run?.id).toBe(x.id)
    let yClaimed: AgentRun | null = null
    // The segment "fails over" to Y and answers from it; while it runs, Y's pool is still empty.
    await _executeClaimedForTests(run!, async () => {
      yClaimed = await claim([y], limits)
      return { status: 'done', usage: { inputTokens: 1, outputTokens: 1, modelDefId: Y } } as RunOutcome
    })
    expect(yClaimed?.id).toBe(y.id)
    const [xRow] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, x.id))
    expect(xRow!.modelDefId).toBe(X)
    expect(xRow!.status).toBe('done')
  })

  it('a workstream\'s segment is stamped with its primary model (today: the head of reasoning)', async () => {
    const origin = await conv()
    const ws = await startWorkstream({ goal: `POOLS-TEST ${tag} stamp`, originConversationId: origin }, { kick: false })
    convIds.push(ws.conversationId)
    const [seg] = await useDb().select().from(agentRuns).where(and(eq(agentRuns.conversationId, ws.conversationId), eq(agentRuns.kind, 'workstream')))
    const head = resolveChainFrom(await loadConfig(), 'reasoning')[0]!.modelDefId
    expect(seg!.modelDefId).toBe(head)
    const [row] = await useDb().select().from(workstreams).where(eq(workstreams.id, ws.id))
    expect(await segmentPrimaryModelId(row!)).toBe(head)
  })
})
