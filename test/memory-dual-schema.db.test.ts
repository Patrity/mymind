// test/memory-dual-schema.db.test.ts
//
// DB-backed — cycle 77, Task 1: migration 0064's 9 new `memories` columns round-trip through
// `getMemory`/`toDTO`, and the `memory_backfill` settings helper (server/lib/memory/backfill-setting.ts)
// is tolerant of a missing/malformed stored value and stamps its timestamps on state transitions.
// See test/memory-resident.db.test.ts for the harness pattern (`.env` load + `useRuntimeConfig`
// stub so `useDb()` works outside Nuxt). The dev DB is SHARED with real data: this file's own rows
// are tagged and deleted in afterAll, and the real `memory_backfill` settings row is snapshotted
// and restored.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories, settings, type SettingRow } from '../server/db/schema'
import { getMemory } from '../server/services/memory'
import {
  MEMORY_BACKFILL_KEY, getBackfillSetting, setBackfillState, type BackfillSetting
} from '../server/lib/memory/backfill-setting'

const TAG = `DUAL-SCHEMA-TEST-${Date.now().toString(36)}`

let settingSnapshot: SettingRow | null = null

beforeAll(async () => {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY)).limit(1)
  settingSnapshot = row ?? null
})

afterAll(async () => {
  await useDb().execute(sql`delete from memories where content like ${TAG + '%'}`)
  const db = useDb()
  await db.delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))
  if (settingSnapshot) await db.insert(settings).values(settingSnapshot)
})

describe('memories schema 0064 — DTO round-trip', () => {
  it('a scoped memory round-trips the new audit/jev/extract fields through toDTO', async () => {
    const content = `${TAG} round-trip`
    const [row] = await useDb().insert(memories).values({
      scope: 'user',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      jevScore: 0.42,
      jevAnswers: { transient: 0.76, rederivable: 0.3, states_reason: 0.89, names_specific: 0.37 },
      jevFailures: 1,
      auditKeep: 0.81,
      auditVerdict: 'keep',
      auditReason: 'durable fact about the system',
      auditModel: 'claude-sonnet-5',
      auditPromptVersion: 'audit-v1',
      auditedAt: new Date(),
      auditFailures: 2,
      extractPromptVersion: 'extract-v3'
    }).returning()

    const dto = await getMemory(row!.id)
    expect(dto).not.toBeNull()
    expect(dto!.jevScore).toBe(0.42)
    expect(dto!.jevAnswers).toEqual({ transient: 0.76, rederivable: 0.3, states_reason: 0.89, names_specific: 0.37 })
    expect(dto!.auditKeep).toBe(0.81)
    expect(dto!.auditVerdict).toBe('keep')
    expect(dto!.auditReason).toBe('durable fact about the system')
    expect(dto!.auditPromptVersion).toBe('audit-v1')
    expect(dto!.extractPromptVersion).toBe('extract-v3')
  })

  it('a memory with none of the new fields set round-trips them all as null', async () => {
    const content = `${TAG} bare`
    const [row] = await useDb().insert(memories).values({
      scope: 'user',
      content,
      contentHash: createHash('sha256').update(content).digest('hex')
    }).returning()

    const dto = await getMemory(row!.id)
    expect(dto).not.toBeNull()
    expect(dto!.jevScore).toBeNull()
    expect(dto!.jevAnswers).toBeNull()
    expect(dto!.auditKeep).toBeNull()
    expect(dto!.auditVerdict).toBeNull()
    expect(dto!.auditReason).toBeNull()
    expect(dto!.auditPromptVersion).toBeNull()
    expect(dto!.extractPromptVersion).toBeNull()
  })

  it('tolerates a stored audit_verdict outside the known set (never throws, DTO verdict is null)', async () => {
    const content = `${TAG} bad-verdict`
    const [row] = await useDb().insert(memories).values({
      scope: 'user',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      auditVerdict: 'not-a-real-verdict'
    }).returning()

    const dto = await getMemory(row!.id)
    expect(dto!.auditVerdict).toBeNull()
  })
})

describe('memory_backfill setting — tolerant parse + stamping', () => {
  it('defaults to off with null timestamps when no row is stored', async () => {
    await useDb().delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))
    const s = await getBackfillSetting()
    expect(s).toEqual<BackfillSetting>({ state: 'off', startedAt: null, finishedAt: null })
  })

  it('falls back to the default on a malformed stored value, without throwing', async () => {
    await useDb().delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))
    await useDb().insert(settings).values({ key: MEMORY_BACKFILL_KEY, value: { state: 'bogus', startedAt: 42 } })
    const s = await getBackfillSetting()
    expect(s).toEqual<BackfillSetting>({ state: 'off', startedAt: null, finishedAt: null })

    await useDb().delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))
    await useDb().insert(settings).values({ key: MEMORY_BACKFILL_KEY, value: 'not-an-object' })
    const s2 = await getBackfillSetting()
    expect(s2).toEqual<BackfillSetting>({ state: 'off', startedAt: null, finishedAt: null })
  })

  it('setBackfillState stamps startedAt on the transition to running and finishedAt on the transition to done', async () => {
    await useDb().delete(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY))

    const running = await setBackfillState('running')
    expect(running.state).toBe('running')
    expect(running.startedAt).not.toBeNull()
    expect(running.finishedAt).toBeNull()

    const stored = await getBackfillSetting()
    expect(stored).toEqual(running)

    const done = await setBackfillState('done')
    expect(done.state).toBe('done')
    expect(done.startedAt).toBe(running.startedAt) // carries over, not re-stamped
    expect(done.finishedAt).not.toBeNull()

    const off = await setBackfillState('off')
    expect(off.state).toBe('off')
    expect(off.startedAt).toBe(running.startedAt)
    expect(off.finishedAt).toBe(done.finishedAt)
  })
})
