// DB-backed — cycle 76, Task 1: schema 0063 round-trips (profile, signals, improvement-linked
// revisions) plus the self_improvement_mode setting. The dev DB is SHARED: every row this file
// creates is scoped to an id it generated and cleaned up in afterAll; the settings key is a real,
// shared row — snapshotted in beforeAll and restored exactly in afterAll.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentProfile, agentSignals, agentConfigRevisions, settings, type SettingRow } from '@mymind/core/db/schema'
import { recordRevision, listRevisions } from '@mymind/core/lib/agent/config/revisions'
import { getSelfImprovementMode, setSelfImprovementMode, SELF_IMPROVEMENT_MODE_KEY } from '@mymind/core/lib/agent/self-improvement-mode'

const profileIds: string[] = []
const signalIds: string[] = []
const revisionTarget = randomUUID()
let modeSnapshot: SettingRow[] = []

beforeAll(async () => {
  modeSnapshot = await useDb().select().from(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
})

afterAll(async () => {
  const db = useDb()
  if (profileIds.length) await db.delete(agentProfile).where(inArray(agentProfile.id, profileIds))
  if (signalIds.length) await db.delete(agentSignals).where(inArray(agentSignals.id, signalIds))
  await db.delete(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, revisionTarget)))
  await db.delete(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
  if (modeSnapshot.length) await db.insert(settings).values(modeSnapshot)
})

describe('agent_profile round-trip', () => {
  it('inserts and reads back a profile row', async () => {
    const [row] = await useDb().insert(agentProfile)
      .values({ content: 'Tony prefers direct critique.', contentHash: 'h1' })
      .returning()
    profileIds.push(row!.id)
    expect(row!.content).toBe('Tony prefers direct critique.')
    expect(row!.updatedBy).toBe('human')

    const [fetched] = await useDb().select().from(agentProfile).where(eq(agentProfile.id, row!.id))
    expect(fetched).toMatchObject({ content: 'Tony prefers direct critique.', contentHash: 'h1', updatedBy: 'human' })
  })
})

describe('agent_signals unique (message_id, kind)', () => {
  it('a duplicate (message_id, kind) is a no-op under onConflictDoNothing', async () => {
    const messageId = randomUUID()
    const [first] = await useDb().insert(agentSignals)
      .values({ messageId, kind: 'replied', detail: 'first' })
      .returning()
    signalIds.push(first!.id)

    const dup = await useDb().insert(agentSignals)
      .values({ messageId, kind: 'replied', detail: 'second' })
      .onConflictDoNothing()
      .returning()
    expect(dup).toHaveLength(0)

    const rows = await useDb().select().from(agentSignals).where(eq(agentSignals.messageId, messageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toBe('first')

    // A different kind for the same message is a distinct row (the unique index is per-kind).
    const [second] = await useDb().insert(agentSignals)
      .values({ messageId, kind: 'ignored' })
      .returning()
    signalIds.push(second!.id)
    expect(second!.kind).toBe('ignored')
  })
})

describe('recordRevision / listRevisions with improvementId', () => {
  it('round-trips improvementId and listRevisions selects it', async () => {
    const improvementId = randomUUID()
    await recordRevision({ targetKind: 'profile', targetId: revisionTarget, content: 'v1', actor: 'agent', improvementId })
    await recordRevision({ targetKind: 'profile', targetId: revisionTarget, content: 'v2', actor: 'human' })

    const listed = await listRevisions('profile', revisionTarget)
    expect(listed.map(r => r.content)).toEqual(['v2', 'v1'])
    expect(listed[0]!.improvementId).toBeNull()
    expect(listed[1]!.improvementId).toBe(improvementId)
  })
})

describe('getSelfImprovementMode / setSelfImprovementMode', () => {
  it('defaults to "on" when unset', async () => {
    await useDb().delete(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
    expect(await getSelfImprovementMode()).toBe('on')
  })

  it('round-trips a valid mode', async () => {
    await setSelfImprovementMode('review_only')
    expect(await getSelfImprovementMode()).toBe('review_only')
    await setSelfImprovementMode('off')
    expect(await getSelfImprovementMode()).toBe('off')
  })

  it('falls back to "on" on a malformed stored value', async () => {
    await useDb().delete(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
    await useDb().insert(settings).values({ key: SELF_IMPROVEMENT_MODE_KEY, value: { not: 'a string' } })
    expect(await getSelfImprovementMode()).toBe('on')

    await useDb().update(settings).set({ value: 'nonsense' }).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
    expect(await getSelfImprovementMode()).toBe('on')
  })
})
