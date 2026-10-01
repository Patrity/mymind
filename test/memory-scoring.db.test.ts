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
const publishChange = vi.hoisted(() => vi.fn())
vi.mock('../server/utils/live-bus', () => ({ publishChange }))

import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { scoreMemory, scoreMemories, selectUnscored } from '../server/services/memory-scoring'
import { runJevScoring } from '../server/services/memory-jev'
import { AUDIT_PROMPT_VERSION } from '../server/lib/memory/extract-v3'
import { JevHttpError, type JevConfig, type JevResponse } from '../server/lib/ai/jev'
import { AiAllFailedError } from '../server/lib/ai/registry/errors'
import { EMPTY_REPLY_ERROR } from '../server/lib/ai/chat'

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
    publishChange.mockClear()
    const res = await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })

    expect(res).toEqual({ id, jev: 'scored', audit: 'scored' })
    // Live-data rule: a background writer emits per item, so /memories and /review refresh.
    // Once per row per call, after both parts settle — not once per part.
    expect(publishChange).toHaveBeenCalledWith({ resource: 'memory', action: 'updated', id })
    expect(publishChange).toHaveBeenCalledTimes(1)
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

  it('a CONTENT failure increments its counter and the 3rd one skips that part', async () => {
    const id = await seed({ jevFailures: 1, auditFailures: 1 })
    // Jev answered, but with nothing usable; the audit answered in prose, not JSON.
    const ask = vi.fn(async () => ({ model: 'jev-1.13.0', answers: {} }))
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

    ask.mockClear(); chatFn.mockClear(); publishChange.mockClear()
    expect(await scoreMemory(id, deps)).toEqual({ id, jev: 'skipped', audit: 'skipped' })
    expect(publishChange).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    row = await load(id)
    expect(row.jevFailures).toBe(3)
    expect(row.auditFailures).toBe(3)
  })

  it('a row archived mid-call is neither stamped nor charged', async () => {
    const failId = await seed()
    const archive = (id: string) => useDb().update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, id))
    // Content failures land after the row was archived: the counters stay put.
    await scoreMemory(failId, {
      ask: vi.fn(async () => { await archive(failId); return { model: 'j', answers: {} } }) as never,
      chatFn: vi.fn(async () => { await archive(failId); return { text: 'prose', model: 'm' } }) as never,
      cfg: CFG
    })
    let row = await load(failId)
    expect(row.jevFailures).toBe(0)
    expect(row.auditFailures).toBe(0)

    // Successes land after the row was archived: nothing is stamped, nothing published.
    const okId = await seed()
    publishChange.mockClear()
    const res = await scoreMemory(okId, {
      ask: vi.fn(async () => { await archive(okId); return JEV_REPLY }) as never,
      chatFn: vi.fn(async () => { await archive(okId); return AUDIT_REPLY }) as never,
      cfg: CFG
    })
    expect(res).toEqual({ id: okId, jev: 'skipped', audit: 'skipped' })
    row = await load(okId)
    expect(row.jevScoredAt).toBeNull()
    expect(row.auditedAt).toBeNull()
    expect(publishChange).not.toHaveBeenCalled()
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

  it('Review Focus 2: two racers on one row — the first writer wins each part, nothing is double-stamped', async () => {
    const id = await seed()
    // Different answers per racer, and a delay so both load the row before either stamps.
    const racer = (tag: string, keep: number) => ({
      ask: vi.fn(async () => { await new Promise(r => setTimeout(r, 20)); return { ...JEV_REPLY, model: `jev-${tag}` } }) as never,
      chatFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 20))
        return { text: JSON.stringify({ keep, verdict: 'keep', reason: tag }), model: `audit-${tag}` }
      }) as never,
      cfg: CFG
    })
    publishChange.mockClear()
    const [a, b] = await Promise.all([scoreMemory(id, racer('A', 0.81)), scoreMemory(id, racer('B', 0.62))])

    // Exactly one racer stamped each part; the other's guarded write was a no-op.
    expect([a.jev, b.jev].filter(o => o === 'scored')).toHaveLength(1)
    expect([a.audit, b.audit].filter(o => o === 'scored')).toHaveLength(1)
    const jevWinner = a.jev === 'scored' ? 'A' : 'B'
    const auditWinner = a.audit === 'scored' ? 'A' : 'B'

    const row = await load(id)
    expect(row.jevModel).toBe(`jev-${jevWinner}`)
    expect(row.auditModel).toBe(`audit-${auditWinner}`)
    expect(row.auditReason).toBe(auditWinner)
    expect(row.auditKeep).toBe(auditWinner === 'A' ? 0.81 : 0.62)
    expect(row.jevFailures).toBe(0)
    expect(row.auditFailures).toBe(0)
    // One publish per call that stamped something: 1 or 2, never one per write (4).
    const publishers = new Set([a, b].filter(r => r.jev === 'scored' || r.audit === 'scored'))
    expect(publishChange).toHaveBeenCalledTimes(publishers.size)
  })
})

describe('scoreMemories', () => {
  it('scores every id, Jev at most 6 in flight and the audit at most 2', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const { ask, chatFn, peaks } = meteredStubs()
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })

    expect(results.map(r => r.id)).toEqual(ids)
    expect(results.every(r => r.jev === 'scored' && r.audit === 'scored')).toBe(true)
    expect(peaks.jev).toBe(6)
    expect(peaks.audit).toBe(2)
  })

  it('the limiters are shared: two concurrent batches together stay at 6 Jev / 2 audit', async () => {
    const idsA = await Promise.all(Array.from({ length: 6 }, () => seed()))
    const idsB = await Promise.all(Array.from({ length: 6 }, () => seed()))
    const { ask, chatFn, peaks } = meteredStubs()
    const deps = { ask: ask as never, cfg: CFG, chatFn: chatFn as never }
    const [ra, rb] = await Promise.all([scoreMemories(idsA, deps), scoreMemories(idsB, deps)])

    expect([...ra, ...rb].every(r => r.jev === 'scored' && r.audit === 'scored')).toBe(true)
    expect(peaks.jev).toBe(6)
    expect(peaks.audit).toBe(2)
  })

  it('a Jev TRANSPORT failure charges no row and stops the batch', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const ask = vi.fn(async () => { throw new Error('Jev 503: upstream unavailable') })
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: okChat() as never })

    expect(results.some(r => r.jev === 'unavailable')).toBe(true)
    expect(results.some(r => r.jev === 'skipped')).toBe(true)   // never started: the batch stopped
    expect(results.some(r => r.jev === 'failed')).toBe(false)
    expect(ask.mock.calls.length).toBeLessThan(ids.length)
    for (const id of ids) expect((await load(id)).jevFailures).toBe(0)
  })

  it('an audit TRANSPORT failure (chain exhausted) charges no row and stops the batch', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const chatFn = vi.fn(async () => { throw new Error('all models failed for usage bulk') })
    const results = await scoreMemories(ids, { ask: okAsk() as never, cfg: null, chatFn: chatFn as never })

    expect(results.some(r => r.audit === 'unavailable')).toBe(true)
    expect(results.some(r => r.audit === 'skipped')).toBe(true)
    expect(results.some(r => r.audit === 'failed')).toBe(false)
    expect(chatFn.mock.calls.length).toBeLessThan(ids.length)
    for (const id of ids) expect((await load(id)).auditFailures).toBe(0)
  })
})

describe('failure classification (fix round 2)', () => {
  it('a Jev 404 on one row is a CONTENT failure: charged, and the batch carries on', async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => seed()))
    const poisoned = (await load(ids[0]!)).content
    const ask = vi.fn(async (state: string) => {
      if (state === poisoned) throw new JevHttpError(404, 'not found')
      return JEV_REPLY
    })
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: okChat() as never })
    expect(results[0]!.jev).toBe('failed')
    expect((await load(ids[0]!)).jevFailures).toBe(1)
    expect(results.slice(1).every(r => r.jev === 'scored')).toBe(true)
    expect(ask).toHaveBeenCalledTimes(4)
  })

  it.each([400, 413, 422])('Jev %i is a content failure', async (status) => {
    const id = await seed()
    const ask = vi.fn(async () => { throw new JevHttpError(status, 'bad') })
    expect((await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: okChat() as never })).jev).toBe('failed')
    expect((await load(id)).jevFailures).toBe(1)
  })

  it('a Jev 401 stops only the Jev part — uncharged — and the audit scores the whole batch', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const ask = vi.fn(async () => { throw new JevHttpError(401, 'invalid key') })
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: okChat() as never })
    expect(results.some(r => r.jev === 'unavailable')).toBe(true)
    expect(results.some(r => r.jev === 'skipped')).toBe(true)
    expect(results.some(r => r.jev === 'failed')).toBe(false)
    expect(ask.mock.calls.length).toBeLessThan(ids.length)
    expect(results.every(r => r.audit === 'scored')).toBe(true)
    for (const id of ids) expect((await load(id)).jevFailures).toBe(0)
  })

  it('N2: Jev down with 503 never slows the audit — every row is audited', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const ask = vi.fn(async () => { throw new JevHttpError(503, 'unavailable') })
    const chatFn = okChat()
    const results = await scoreMemories(ids, { ask: ask as never, cfg: CFG, chatFn: chatFn as never })
    expect(results.every(r => r.audit === 'scored')).toBe(true)
    expect(chatFn).toHaveBeenCalledTimes(10)
    expect(results.some(r => r.jev === 'unavailable')).toBe(true)
    for (const id of ids) expect((await load(id)).jevFailures).toBe(0)
  })

  it('an audit outage never slows Jev — every row is Jev-scored', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const chatFn = vi.fn(async () => { throw new AiAllFailedError('bulk', [{ label: 'a', error: '[POST] 502 Bad Gateway' }]) })
    const results = await scoreMemories(ids, { ask: okAsk() as never, cfg: CFG, chatFn: chatFn as never })
    expect(results.every(r => r.jev === 'scored')).toBe(true)
    expect(results.some(r => r.audit === 'unavailable')).toBe(true)
    expect(chatFn.mock.calls.length).toBeLessThan(ids.length)
  })

  it('a Jev timeout is transport: uncharged', async () => {
    const id = await seed()
    const ask = vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') })
    expect((await scoreMemory(id, { ask: ask as never, cfg: CFG, chatFn: okChat() as never })).jev).toBe('unavailable')
    expect((await load(id)).jevFailures).toBe(0)
  })

  it('an empty audit reply from every chain member is a CONTENT failure: charged, the audit carries on', async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => seed()))
    const poisoned = (await load(ids[0]!)).content
    const chatFn = vi.fn(async (_role: string, messages: { content: string }[]) => {
      if (messages[1]!.content.includes(poisoned)) {
        throw new AiAllFailedError('bulk', [{ label: 'a', error: EMPTY_REPLY_ERROR }, { label: 'b', error: EMPTY_REPLY_ERROR }])
      }
      return AUDIT_REPLY
    })
    const results = await scoreMemories(ids, { ask: okAsk() as never, cfg: CFG, chatFn: chatFn as never })
    expect(results[0]!.audit).toBe('failed')
    expect((await load(ids[0]!)).auditFailures).toBe(1)
    expect(results.slice(1).every(r => r.audit === 'scored')).toBe(true)
  })
})

describe('audit poison rows (final review I1)', () => {
  it('a row every chain member refuses with 400 is CONTENT: charged, and the audit carries on', async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => seed()))
    const poisoned = (await load(ids[0]!)).content
    const chatFn = vi.fn(async (_role: string, messages: { content: string }[]) => {
      if (messages[1]!.content.includes(poisoned)) {
        throw new AiAllFailedError('bulk', [{ label: 'a', error: '[POST] 400', status: 400 }, { label: 'b', error: '[POST] 400', status: 400 }])
      }
      return AUDIT_REPLY
    })
    const results = await scoreMemories(ids, { ask: okAsk() as never, cfg: CFG, chatFn: chatFn as never })
    expect(results[0]!.audit).toBe('failed')
    expect((await load(ids[0]!)).auditFailures).toBe(1)
    expect(results.slice(1).every(r => r.audit === 'scored')).toBe(true)
    expect(chatFn).toHaveBeenCalledTimes(4)
  })

  it('every chain member answering 503 stays TRANSPORT: nobody charged, the audit stops', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => seed()))
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', [{ label: 'a', error: '[POST] 503', status: 503 }, { label: 'b', error: '[POST] 503', status: 503 }])
    })
    const results = await scoreMemories(ids, { ask: okAsk() as never, cfg: CFG, chatFn: chatFn as never })
    expect(results.some(r => r.audit === 'unavailable')).toBe(true)
    expect(results.some(r => r.audit === 'failed')).toBe(false)
    expect(chatFn.mock.calls.length).toBeLessThan(ids.length)
    for (const id of ids) expect((await load(id)).auditFailures).toBe(0)
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
    const all = { onlyIds, jevConfigured: true }
    // unreviewedOnly: false (the backfill) includes reviewed rows (spec D2).
    expect(await selectUnscored(10, { ...all, unreviewedOnly: false })).toEqual([unreviewedOld, auditOnlyMissing, unreviewedNew, reviewedOld])
    expect(await selectUnscored(10, all)).toEqual([unreviewedOld, auditOnlyMissing, unreviewedNew, reviewedOld])
    expect(await selectUnscored(2, all)).toEqual([unreviewedOld, auditOnlyMissing])
    // unreviewedOnly: true (the cron) drops the reviewed row.
    expect(await selectUnscored(10, { ...all, unreviewedOnly: true })).toEqual([unreviewedOld, auditOnlyMissing, unreviewedNew])
    expect(await selectUnscored(10, { onlyIds: [], jevConfigured: true })).toEqual([])
    expect(await selectUnscored(10, all)).not.toContain(notInScope)
  })

  it('with Jev unconfigured, a missing Jev score alone does not select a row', async () => {
    const audited = await seed({ auditPromptVersion: AUDIT_PROMPT_VERSION })   // only Jev missing
    const unaudited = await seed()
    const onlyIds = [audited, unaudited]
    expect(await selectUnscored(10, { onlyIds, jevConfigured: false })).toEqual([unaudited])
    expect(await selectUnscored(10, { onlyIds, jevConfigured: true })).toEqual(expect.arrayContaining([audited, unaudited]))
  })
})

describe('runJevScoring (the queue scorer) on the shared path', () => {
  it('scores UNREVIEWED memories only — reviewed rows wait for the backfill', async () => {
    const reviewed = await seed({ reviewedAt: new Date() })
    const unreviewed = await seed()
    const ask = okAsk()
    const res = await runJevScoring({
      limit: 50, onlyIds: [reviewed, unreviewed],
      deps: { ask: ask as never, cfg: CFG, chatFn: okChat() as never }
    })
    expect(res).toMatchObject({ considered: 1, scored: 1, failed: 0, audited: 1, auditFailed: 0, stoppedEarly: false })
    expect((await load(unreviewed)).jevModel).toBe('jev-1.13.0')
    const r = await load(reviewed)
    expect(r.jevScoredAt).toBeNull()
    expect(r.auditedAt).toBeNull()
  })

  it('counts a Jev content failure against the row', async () => {
    const failing = await seed()
    const ask = vi.fn(async () => ({ model: 'jev-1.13.0', answers: {} }))
    const res = await runJevScoring({ onlyIds: [failing], deps: { ask: ask as never, cfg: CFG, chatFn: okChat() as never } })
    expect(res).toMatchObject({ considered: 1, scored: 0, failed: 1, audited: 1 })
    expect((await load(failing)).jevFailures).toBe(1)
  })

  it('with Jev unconfigured, still audits rows lacking an audit and skips rows that have one', async () => {
    const audited = await seed({ auditPromptVersion: AUDIT_PROMPT_VERSION })
    const unaudited = await seed()
    const ask = okAsk()
    const chatFn = okChat()
    const res = await runJevScoring({ onlyIds: [audited, unaudited], deps: { ask: ask as never, cfg: null, chatFn: chatFn as never } })
    expect(res).toMatchObject({ considered: 1, scored: 0, failed: 0, audited: 1, jev: 'not-configured' })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).toHaveBeenCalledTimes(1)
    expect((await load(unaudited)).auditPromptVersion).toBe(AUDIT_PROMPT_VERSION)
  })
})

/** Stubs that record their peak in-flight count. */
function meteredStubs() {
  const peaks = { jev: 0, audit: 0 }
  let jevIn = 0, auditIn = 0
  const ask = vi.fn(async () => {
    peaks.jev = Math.max(peaks.jev, ++jevIn)
    await new Promise(r => setTimeout(r, 15))
    jevIn--
    return JEV_REPLY
  })
  const chatFn = vi.fn(async () => {
    peaks.audit = Math.max(peaks.audit, ++auditIn)
    await new Promise(r => setTimeout(r, 15))
    auditIn--
    return AUDIT_REPLY
  })
  return { ask, chatFn, peaks }
}
