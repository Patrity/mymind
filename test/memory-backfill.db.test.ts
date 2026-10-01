// test/memory-backfill.db.test.ts
//
// DB-backed — cycle 77, Task 5: the switch-gated, resumable dual-score backfill
// (server/services/memory-backfill.ts). Harness pattern: test/memory-scoring.db.test.ts.
//
// The dev DB is SHARED with real data:
// - every memory here carries TAG in its content and is deleted in afterAll;
// - every batch / progress read goes through the `onlyIds` seam;
// - Jev and the model are always stubbed (`ask` / `chatFn` / `cfg`);
// - the real `memory_backfill` settings row is snapshotted and restored, and every test that
//   flips it to `running` puts it back to `off` before it ends (afterEach), so a dev server on
//   this DB never sees `running` for longer than one test.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
const publishChange = vi.hoisted(() => vi.fn())
vi.mock('../server/utils/live-bus', () => ({ publishChange }))

import { createHash } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories, settings, type SettingRow } from '../server/db/schema'
import { MEMORY_BACKFILL_KEY, getBackfillSetting, setBackfillState } from '../server/lib/memory/backfill-setting'
import { backfillProgress, etaFromRuns, resetBackfillProcessState, runBackfillBatch, setBackfillSwitch } from '../server/services/memory-backfill'
import { runJevScoring } from '../server/services/memory-jev'
import { AUDIT_PROMPT_VERSION } from '../server/lib/memory/extract-v3'
import { JevHttpError, type JevConfig, type JevResponse } from '../server/lib/ai/jev'
import { AiAllFailedError } from '../server/lib/ai/registry/errors'

const TAG = `BACKFILL-TEST-${Date.now().toString(36)}`
const CFG: JevConfig = { baseURL: 'http://jev.invalid', apiKey: 'k', model: 'jev-latest' }

let settingSnapshot: SettingRow | undefined

beforeAll(async () => {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY)).limit(1)
  settingSnapshot = row
})

afterEach(async () => {
  // Never leave the switch `running` on the shared dev DB between tests.
  await setBackfillState('off')
  resetBackfillProcessState()
})

afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from memories where content like ${TAG + '%'}`)
  await db.delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))
  if (settingSnapshot) await db.insert(settings).values(settingSnapshot)
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

function stubs() {
  const ask = vi.fn(async () => JEV_REPLY)
  const chatFn = vi.fn(async () => AUDIT_REPLY)
  return { ask, chatFn, deps: { ask: ask as never, chatFn: chatFn as never, cfg: CFG } }
}

const backfillEvents = () => publishChange.mock.calls.filter(([e]) => e.resource === 'memoryBackfill')

describe('runBackfillBatch', () => {
  it('does nothing while the switch is off', async () => {
    await setBackfillState('off')
    const id = await seed()
    const { ask, chatFn, deps } = stubs()
    publishChange.mockClear()

    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 0, done: false })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    expect((await load(id)).jevScoredAt).toBeNull()
    expect((await getBackfillSetting()).state).toBe('off')
    expect(publishChange).not.toHaveBeenCalled()
  })

  it('also does nothing once done (only `running` works)', async () => {
    await setBackfillState('done')
    const id = await seed()
    const { ask, deps } = stubs()
    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 0, done: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('while running, scores up to the limit — reviewed memories included — and publishes progress', async () => {
    await setBackfillState('running')
    const ids = [await seed(), await seed({ reviewedAt: new Date() }), await seed()]
    const { ask, chatFn, deps } = stubs()
    publishChange.mockClear()

    const res = await runBackfillBatch({ limit: 2, onlyIds: ids, deps })
    expect(res).toEqual({ processed: 2, done: false })
    expect(ask).toHaveBeenCalledTimes(2)
    expect(chatFn).toHaveBeenCalledTimes(2)

    // Unreviewed first, then oldest: ids[0] and ids[2] (the reviewed row waits for the next run).
    const rows = await Promise.all(ids.map(load))
    expect(rows.map(r => r.jevScoredAt !== null)).toEqual([true, false, true])
    expect(rows.map(r => r.auditPromptVersion)).toEqual([AUDIT_PROMPT_VERSION, null, AUDIT_PROMPT_VERSION])
    expect(backfillEvents()).toEqual([[{ resource: 'memoryBackfill', action: 'updated', id: MEMORY_BACKFILL_KEY }]])
    expect((await getBackfillSetting()).state).toBe('running')

    // The next run picks up the reviewed row (the backfill walks the whole live population).
    await expect(runBackfillBatch({ limit: 2, onlyIds: ids, deps })).resolves.toMatchObject({ processed: 1 })
    expect((await load(ids[1]!)).jevScoredAt).not.toBeNull()
    expect((await load(ids[1]!)).auditPromptVersion).toBe(AUDIT_PROMPT_VERSION)
  })

  it('flips the switch to done (and publishes) once nothing is left to score', async () => {
    await setBackfillState('running')
    const id = await seed({
      jevScoredAt: new Date(), jevScore: 0.5, auditPromptVersion: AUDIT_PROMPT_VERSION, auditKeep: 0.5, auditedAt: new Date()
    })
    const { ask, chatFn, deps } = stubs()
    publishChange.mockClear()

    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 0, done: true })
    expect(ask).not.toHaveBeenCalled()
    expect(chatFn).not.toHaveBeenCalled()
    const s = await getBackfillSetting()
    expect(s.state).toBe('done')
    expect(s.finishedAt).not.toBeNull()
    expect(backfillEvents()).toHaveLength(1)
  })

  it('a transport failure is NOT completion: the row stays selected and the state stays running', async () => {
    await setBackfillState('running')
    const id = await seed()
    const ask = vi.fn(async () => { throw new TypeError('fetch failed') })
    const chatFn = vi.fn(async () => AUDIT_REPLY)
    const res = await runBackfillBatch({ onlyIds: [id], deps: { ask: ask as never, chatFn: chatFn as never, cfg: CFG } })
    expect(res.done).toBe(false)
    expect((await getBackfillSetting()).state).toBe('running')
    expect((await load(id)).jevFailures).toBe(0)
    expect((await backfillProgress({ onlyIds: [id], deps: { cfg: CFG } })).lastError).toMatch(/jev/i)

    // Jev back: the next run finishes the row and the run after that is done.
    const { deps } = stubs()
    await runBackfillBatch({ onlyIds: [id], deps })
    expect((await load(id)).jevScoredAt).not.toBeNull()
    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 0, done: true })
  })

  it('Review Focus 3: a memory archived between two batches is not scored', async () => {
    await setBackfillState('running')
    const a = await seed()
    const b = await seed()
    const { ask, chatFn, deps } = stubs()

    await runBackfillBatch({ limit: 1, onlyIds: [a, b], deps })
    expect((await load(a)).jevScoredAt).not.toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)

    await useDb().update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, b))
    await expect(runBackfillBatch({ limit: 1, onlyIds: [a, b], deps })).resolves.toEqual({ processed: 0, done: true })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(chatFn).toHaveBeenCalledTimes(1)
    const rowB = await load(b)
    expect(rowB.jevScoredAt).toBeNull()
    expect(rowB.auditPromptVersion).toBeNull()
  })

  it('Review Focus 2: racing the queue scorer on one row stamps it once, identically, with one memory event', async () => {
    await setBackfillState('running')
    const id = await seed()
    // Both callers read the row as unscored before either answers.
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const ask = vi.fn(async () => { await gate; return JEV_REPLY })
    const chatFn = vi.fn(async () => { await gate; return AUDIT_REPLY })
    const deps = { ask: ask as never, chatFn: chatFn as never, cfg: CFG }
    publishChange.mockClear()

    const both = Promise.all([
      runBackfillBatch({ onlyIds: [id], deps }),
      runJevScoring({ onlyIds: [id], deps })
    ])
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2))
    release()
    const [backfill, queue] = await both

    const row = await load(id)
    expect(row.jevScore).not.toBeNull()
    expect(row.jevModel).toBe('jev-1.13.0')
    expect(row.auditVerdict).toBe('keep')
    expect(row.auditKeep).toBeCloseTo(0.85)
    expect(row.jevFailures).toBe(0)
    expect(row.auditFailures).toBe(0)
    // First writer wins PER PART; the loser's write is a no-op. One caller may win Jev and the
    // other the audit, so each caller emits at most once — never one event per write attempt.
    const memoryEvents = publishChange.mock.calls.filter(([e]) => e.resource === 'memory' && e.id === id)
    expect(memoryEvents.length).toBeGreaterThanOrEqual(1)
    expect(memoryEvents.length).toBeLessThanOrEqual(2)
    expect(backfill.processed).toBe(1)
    expect(queue.considered).toBe(1)
    expect(queue.failed).toBe(0)
    expect(queue.auditFailed).toBe(0)
    expect(queue.stoppedEarly).toBe(false)
  })

  it('Jev unconfigured: a row with only the audit missing finishes and the backfill can reach done', async () => {
    await setBackfillState('running')
    const id = await seed()
    const chatFn = vi.fn(async () => AUDIT_REPLY)
    const deps = { chatFn: chatFn as never, cfg: null }
    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 1, done: false })
    await expect(runBackfillBatch({ onlyIds: [id], deps })).resolves.toEqual({ processed: 0, done: true })
    expect((await load(id)).jevScoredAt).toBeNull()
  })
})

describe('one part down across batches (final review I2)', () => {
  it('Jev down for two runs: the audit still advances to new rows each run', async () => {
    await setBackfillState('running')
    const ids = [await seed(), await seed(), await seed(), await seed()]
    const ask = vi.fn(async () => { throw new JevHttpError(503, 'unavailable') })
    const chatFn = vi.fn(async () => AUDIT_REPLY)
    const deps = { ask: ask as never, chatFn: chatFn as never, cfg: CFG }

    await runBackfillBatch({ limit: 2, onlyIds: ids, deps })
    await runBackfillBatch({ limit: 2, onlyIds: ids, deps })

    const rows = await Promise.all(ids.map(load))
    expect(rows.every(r => r.auditPromptVersion === AUDIT_PROMPT_VERSION)).toBe(true)
    expect(rows.every(r => r.jevScoredAt === null && r.jevFailures === 0)).toBe(true)
    expect((await getBackfillSetting()).state).toBe('running')
  })

  it('the audit chain down for two runs: Jev still advances to new rows each run', async () => {
    await setBackfillState('running')
    const ids = [await seed(), await seed(), await seed(), await seed()]
    const ask = vi.fn(async () => JEV_REPLY)
    const chatFn = vi.fn(async () => { throw new AiAllFailedError('bulk', [{ label: 'a', error: '[POST] 503', status: 503 }]) })
    const deps = { ask: ask as never, chatFn: chatFn as never, cfg: CFG }

    await runBackfillBatch({ limit: 2, onlyIds: ids, deps })
    await runBackfillBatch({ limit: 2, onlyIds: ids, deps })

    const rows = await Promise.all(ids.map(load))
    expect(rows.every(r => r.jevScoredAt !== null)).toBe(true)
    expect(rows.every(r => r.auditPromptVersion === null && r.auditFailures === 0)).toBe(true)
  })
})

describe('setBackfillSwitch', () => {
  it('sets the state and publishes memoryBackfill on a change; a repeat is a silent no-op', async () => {
    await setBackfillState('off')
    publishChange.mockClear()

    const first = await setBackfillSwitch('running')
    expect(first.state).toBe('running')
    expect(first.startedAt).not.toBeNull()
    expect(backfillEvents()).toHaveLength(1)

    // Re-pressing Start must not reset startedAt (it anchors the ETA).
    const again = await setBackfillSwitch('running')
    expect(again.startedAt).toBe(first.startedAt)
    expect(backfillEvents()).toHaveLength(1)

    await expect(setBackfillSwitch('off')).resolves.toMatchObject({ state: 'off' })
    expect(backfillEvents()).toHaveLength(2)
  })
})

describe('backfillProgress', () => {
  it('counts live memories by part, skipped (≥3 failures) and remaining — scoped via onlyIds', async () => {
    await setBackfillState('off')
    const now = new Date()
    const ids = [
      // both done
      await seed({ jevScoredAt: now, jevScore: 0.5, auditPromptVersion: AUDIT_PROMPT_VERSION, auditedAt: now }),
      // jev done, audit missing
      await seed({ jevScoredAt: now, jevScore: 0.5 }),
      // audit done on an OLD prompt version (= still missing), jev missing
      await seed({ auditPromptVersion: 'audit-v0', auditedAt: now }),
      // jev capped (skipped), audit done
      await seed({ jevFailures: 3, auditPromptVersion: AUDIT_PROMPT_VERSION, auditedAt: now }),
      // audit capped (skipped), jev missing (still remaining)
      await seed({ auditFailures: 3 }),
      // archived: not counted at all
      await seed({ archivedAt: now })
    ]
    const p = await backfillProgress({ onlyIds: ids, deps: { cfg: CFG } })
    expect(p).toEqual({
      state: 'off',
      total: 5,
      jevDone: 2,
      auditDone: 2,
      skipped: 2,
      remaining: 3,   // rows 2, 3, 5
      startedAt: expect.any(String),
      etaMinutes: null,   // not running
      lastError: null
    })

    // Jev unconfigured: a missing Jev score is not "remaining" (row 5's audit is capped).
    expect((await backfillProgress({ onlyIds: ids, deps: { cfg: null } })).remaining).toBe(2)
  })

  it('ETA comes from the backfill\'s own runs: null after one run, a number after two', async () => {
    await setBackfillState('running')
    resetBackfillProcessState()
    const ids = [await seed(), await seed(), await seed(), await seed()]
    const { deps } = stubs()
    expect((await backfillProgress({ onlyIds: ids, deps: { cfg: CFG } })).etaMinutes).toBeNull()

    await runBackfillBatch({ limit: 1, onlyIds: ids, deps })
    expect((await backfillProgress({ onlyIds: ids, deps: { cfg: CFG } })).etaMinutes).toBeNull()

    await runBackfillBatch({ limit: 1, onlyIds: ids, deps })
    const p = await backfillProgress({ onlyIds: ids, deps: { cfg: CFG } })
    expect(p.remaining).toBe(2)
    expect(p.etaMinutes).toEqual(expect.any(Number))
    expect(p.etaMinutes).toBeGreaterThan(0)

    // A switch change forgets the runs (a pause/resume never stretches the window).
    await setBackfillSwitch('off')
    await setBackfillSwitch('running')
    expect((await backfillProgress({ onlyIds: ids, deps: { cfg: CFG } })).etaMinutes).toBeNull()
  })
})

describe('etaFromRuns', () => {
  const min = 60_000
  it('rows finished by runs 2..n over the time since run 1', () => {
    // One 40-row run every 5 min → 8 rows/min; 1563 left → 196 min (the old average said 14).
    expect(etaFromRuns([{ at: 0, completed: 40 }, { at: 5 * min, completed: 40 }], 1563)).toBe(196)
    expect(etaFromRuns([{ at: 0, completed: 40 }, { at: 5 * min, completed: 40 }, { at: 10 * min, completed: 20 }], 60)).toBe(10)
  })
  it('null with fewer than 2 runs or no progress; 0 when nothing remains', () => {
    expect(etaFromRuns([], 10)).toBeNull()
    expect(etaFromRuns([{ at: 0, completed: 40 }], 10)).toBeNull()
    expect(etaFromRuns([{ at: 0, completed: 40 }, { at: 5 * min, completed: 0 }], 10)).toBeNull()
    expect(etaFromRuns([{ at: 0, completed: 40 }], 0)).toBe(0)
  })
})
