// test/memory-scoring.db.test.ts
//
// DB-backed — cycle 77, Task 4: the one scoring path (server/services/memory-scoring.ts) that runs
// Jev and the extract-v3 audit on a live memory, plus the queue scorer (runJevScoring) now built
// on it. Harness pattern: test/memory-resident.db.test.ts (`.env` load + `useRuntimeConfig` stub).
//
// The dev DB is SHARED with real data. Every row here carries TAG in its content and is deleted in
// afterAll; every selection goes through the `onlyIds` seam; Jev and the model are always stubbed
// (`ask` / `chatFn` / `cfg`) — nothing here reaches a real Jev or a real model.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { scoreMemory, scoreMemories, selectUnscored } from '../server/services/memory-scoring'
import { runJevScoring } from '../server/services/memory-jev'
import { AUDIT_PROMPT_VERSION } from '../server/lib/memory/extract-v3'
import type { JevConfig, JevResponse } from '../server/lib/ai/jev'

const TAG = `SCORING-TEST-${Date.now().toString(36)}`
const CFG: JevConfig = { baseURL: 'http://jev.invalid', apiKey: 'k', model: 'jev-latest' }

afterAll(async () => {
  await useDb().execute(sql`delete from memories where content like ${TAG + '%'}`)
})

let seq = 0
async function seed(over: Partial<typeof memories.$inferInsert> = {}): Promise<string> {
  const content = `${TAG} memory ${++seq} ${crypto.randomUUID()}`
  const [row] = await useDb().insert(memories).values({
    scope: 'agent',
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    ...over
  }).returning({ id: memories.id })
  return row!.id
}

async function load(id: string) {
  const [row] = await useDb().select().from(memories).where(eq(memories.id, id)).limit(1)
  return row!
}

const JEV_REPLY: JevResponse = {
  model: 'jev-1.13.0',
  answers: {
    transient: { type: 'noul', noul: 0.2 },
    rederivable: { type: 'noul', noul: 0.3 },
    states_reason: { type: 'noul', noul: 0.8 },
    names_specific: { type: 'noul', noul: 0.7 }
  }
}
const AUDIT_REPLY = { text: JSON.stringify({ keep: 0.85, verdict: 'keep', reason: 'Durable fact.' }), model: 'audit-model-x' }

function okAsk() { return vi.fn(async () => JEV_REPLY) }
function okChat() { return vi.fn(async () => AUDIT_REPLY) }

describe('scoreMemory', () => {
  it('stamps both scores: jev answers + model, and every audit field + version', async () => {
    const id = await seed()
    const ask = okAsk()
    const chatFn = okChat()
    const res = await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })

    expect(res).toEqual({ id, jev: 'scored', audit: 'scored' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(chatFn).toHaveBeenCalledTimes(1)

    const row = await load(id)
    expect(row.jevAnswers).toEqual({ transient: 0.2, rederivable: 0.3, states_reason: 0.8, names_specific: 0.7 })
    expect(row.jevModel).toBe('jev-1.13.0')
    expect(row.jevScore).not.toBeNull()
    expect(row.jevScoredAt).toBeInstanceOf(Date)
    expect(row.auditKeep).toBe(0.85)
    expect(row.auditVerdict).toBe('keep')
    expect(row.auditReason).toBe('Durable fact.')
    expect(row.auditModel).toBe('audit-model-x')
    expect(row.auditPromptVersion).toBe(AUDIT_PROMPT_VERSION)
    expect(row.auditedAt).toBeInstanceOf(Date)
    expect(row.jevFailures).toBe(0)
    expect(row.auditFailures).toBe(0)
  })

  it('skips a part that is already scored', async () => {
    const id = await seed({
      jevScoredAt: new Date(), jevScore: 0.5, jevModel: 'old-jev',
      auditPromptVersion: AUDIT_PROMPT_VERSION, auditKeep: 0.4, auditVerdict: 'transient', auditedAt: new Date()
    })
    const ask = okAsk()
    const chatFn = okChat()
    const res = await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })

    expect(res).toEqual({ id, jev: 'skipped', audit: 'skipped' })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    const row = await load(id)
    expect(row.jevModel).toBe('old-jev')
    expect(row.auditVerdict).toBe('transient')
  })

  it('re-audits a row stamped by an older audit prompt version', async () => {
    const id = await seed({ jevScoredAt: new Date(), auditPromptVersion: 'audit-v0', auditVerdict: 'transient' })
    const chatFn = okChat()
    const res = await scoreMemory(id, { ask: okAsk() as never, cfg: CFG, chatFn: chatFn as never })
    expect(res.audit).toBe('scored')
    expect((await load(id)).auditPromptVersion).toBe(AUDIT_PROMPT_VERSION)
  })

  it('a failure increments its counter and the 3rd failure skips that part', async () => {
    const id = await seed({ jevFailures: 1, auditFailures: 1 })
    const ask = vi.fn(async () => { throw new Error('Jev 500: down') })
    // Prose, not JSON — parseAudit fails it.
    const chatFn = vi.fn(async () => ({ text: 'I think this memory is fine.', model: 'm' }))
    const deps = { ask: ask as never, cfg: CFG, chatFn: chatFn as never }

    expect(await scoreMemory(id, deps)).toEqual({ id, jev: 'failed', audit: 'failed' })
    let row = await load(id)
    expect(row.jevFailures).toBe(2)
    expect(row.auditFailures).toBe(2)
    expect(row.jevScoredAt).toBeNull()
    expect(row.auditPromptVersion).toBeNull()

    expect(await scoreMemory(id, deps)).toEqual({ id, jev: 'failed', audit: 'failed' })
    row = await load(id)
    expect(row.jevFailures).toBe(3)
    expect(row.auditFailures).toBe(3)

    ask.mockClear(); chatFn.mockClear()
    expect(await scoreMemory(id, deps)).toEqual({ id, jev: 'skipped', audit: 'skipped' })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    row = await load(id)
    expect(row.jevFailures).toBe(3)
    expect(row.auditFailures).toBe(3)
  })

  it('never scores an archived row', async () => {
    const id = await seed({ archivedAt: new Date() })
    const ask = okAsk()
    const chatFn = okChat()
    const res = await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })
    expect(res).toEqual({ id, jev: 'skipped', audit: 'skipped' })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    const row = await load(id)
    expect(row.jevScoredAt).toBeNull()
    expect(row.auditedAt).toBeNull()
  })

  it('skips Jev (and still audits) when Jev is not configured', async () => {
    const id = await seed()
    const ask = okAsk()
    const res = await scoreMemory(id, { ask: ask as never, cfg: null, chatFn: okChat() as never })
    expect(res).toEqual({ id, jev: 'skipped', audit: 'scored' })
    expect(ask).not.toHaveBeenCalled()
    expect((await load(id)).jevFailures).toBe(0)
  })

  it('Review Focus 2: two concurrent calls on one row leave a consistent final state', async () => {
    const id = await seed()
    const deps = { ask: okAsk() as never, cfg: CFG, chatFn: okChat() as never }
    const [a, b] = await Promise.all([scoreMemory(id, deps), scoreMemory(id, deps)])
    for (const r of [a, b]) {
      expect(r.jev === 'scored' || r.jev === 'skipped').toBe(true)
      expect(r.audit === 'scored' || r.audit === 'skipped').toBe(true)
    }
    const row = await load(id)
    expect(row.jevModel).toBe('jev-1.13.0')
    expect(row.jevAnswers).toEqual({ transient: 0.2, rederivable: 0.3, states_reason: 0.8, names_specific: 0.7 })
    expect(row.auditVerdict).toBe('keep')
    expect(row.auditKeep).toBe(0.85)
    expect(row.auditModel).toBe('audit-model-x')
    expect(row.auditPromptVersion).toBe(AUDIT_PROMPT_VERSION)
    expect(row.jevFailures).toBe(0)
    expect(row.auditFailures).toBe(0)
  })
})

describe('scoreMemories', () => {
  it('scores every id, Jev at most 6 in flight and the audit at most 2', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    let jevInFlight = 0, jevPeak = 0, auditInFlight = 0, auditPeak = 0
    const ask = vi.fn(async () => {
      jevPeak = Math.max(jevPeak, ++jevInFlight)
      await new Promise(r => setTimeout(r, 15))
      jevInFlight--
      return JEV_REPLY
    })
    const chatFn = vi.fn(async () => {
      auditPeak = Math.max(auditPeak, ++auditInFlight)
      await new Promise(r => setTimeout(r, 15))
      auditInFlight--
      return AUDIT_REPLY
    })
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })

    expect(results.map(r => r.id)).toEqual(ids)
    expect(results.every(r => r.jev === 'scored' && r.audit === 'scored')).toBe(true)
    expect(jevPeak).toBe(6)
    expect(auditPeak).toBe(2)
  })
})

describe('selectUnscored', () => {
  it('orders unreviewed first, then oldest; excludes scored, exhausted and archived rows; respects onlyIds', async () => {
    const t = (d: number) => new Date(Date.UTC(2020, 0, d))
    const reviewedOld = await seed({ reviewedAt: t(9), createdAt: t(1) })
    const unreviewedNew = await seed({ createdAt: t(5) })
    const unreviewedOld = await seed({ createdAt: t(2) })
    const auditOnlyMissing = await seed({ createdAt: t(3), jevScoredAt: t(4) })
    const fullyScored = await seed({ createdAt: t(1), jevScoredAt: t(4), auditPromptVersion: AUDIT_PROMPT_VERSION })
    const exhausted = await seed({ createdAt: t(1), jevFailures: 3, auditFailures: 3 })
    const archived = await seed({ createdAt: t(1), archivedAt: t(6) })
    const notInScope = await seed({ createdAt: t(1) })

    const onlyIds = [reviewedOld, unreviewedNew, unreviewedOld, auditOnlyMissing, fullyScored, exhausted, archived]
    expect(await selectUnscored(10, { onlyIds })).toEqual([unreviewedOld, auditOnlyMissing, unreviewedNew, reviewedOld])
    expect(await selectUnscored(2, { onlyIds })).toEqual([unreviewedOld, auditOnlyMissing])
    expect(await selectUnscored(10, { onlyIds: [] })).toEqual([])
    expect(await selectUnscored(10, { onlyIds })).not.toContain(notInScope)
  })
})

describe('runJevScoring (the queue scorer) on the shared path', () => {
  it('scores a REVIEWED memory too (spec D2) and counts jev failures', async () => {
    const reviewed = await seed({ reviewedAt: new Date() })
    const failing = await seed()
    const ask = vi.fn(async (state: string) => {
      if (state === (await load(failing)).content) throw new Error('Jev 503')
      return JEV_REPLY
    })
    const res = await runJevScoring({
      limit: 50, onlyIds: [reviewed, failing],
      deps: { ask: ask as never, cfg: CFG, chatFn: okChat() as never }
    })
    expect(res).toMatchObject({ considered: 2, scored: 1, failed: 1, audited: 2, auditFailed: 0 })
    expect((await load(reviewed)).jevModel).toBe('jev-1.13.0')
    expect((await load(failing)).jevFailures).toBe(1)
  })

  it('reports not-configured when Jev has no config', async () => {
    const id = await seed()
    const res = await runJevScoring({ onlyIds: [id], deps: { ask: okAsk() as never, cfg: null, chatFn: okChat() as never } })
    expect(res).toEqual({ considered: 0, scored: 0, failed: 0, skipped: 'not-configured' })
  })
})
