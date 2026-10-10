// DB-backed — cycle 76, Task 2: server/services/profile.ts (the "About Tony" profile). The dev
// DB is SHARED and `agent_profile` is a SINGLETON (at most one real row, no slug to scope a
// fixture prefix to) — so this file snapshots whatever is there in beforeAll and restores it
// byte-for-byte in afterAll, deleting only the revisions IT created (by id, diffed against the
// revision ids that existed before this file ran). The first test deliberately clears the table
// (already snapshotted) so the lazy-create path is exercised for real every run, not skipped
// when a real profile row happens to already exist.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentProfile, agentConfigRevisions, type AgentProfileRow } from '@mymind/core/db/schema'
import { getProfileSource, saveProfileSource, listProfileRevisions, revertProfile } from '@mymind/core/services/profile'
import { ConflictError } from '@mymind/core/services/skills'

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex')

let snapshot: AgentProfileRow | null = null
// The snapshot row's revisions, in full: some tests clear the whole table (and its profile
// revisions) to exercise the lazy-create path, so the original rows are re-inserted afterwards.
let snapshotRevisions: (typeof agentConfigRevisions.$inferSelect)[] = []

beforeAll(async () => {
  const rows = await useDb().select().from(agentProfile)
  snapshot = rows[0] ?? null
  if (snapshot) {
    snapshotRevisions = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, snapshot.id)))
  }
})

afterAll(async () => {
  const db = useDb()
  // Remove every profile row this file created, and its revisions, other than the snapshot's row.
  const rows = await db.select().from(agentProfile)
  for (const row of rows) {
    if (!snapshot || row.id !== snapshot.id) {
      await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, row.id)))
      await db.delete(agentProfile).where(eq(agentProfile.id, row.id))
    }
  }
  if (snapshot) {
    // Restore the original row byte-for-byte — re-inserting it if a test deleted it.
    await db.insert(agentProfile).values(snapshot).onConflictDoUpdate({
      target: agentProfile.id,
      set: { content: snapshot.content, contentHash: snapshot.contentHash, updatedBy: snapshot.updatedBy, updatedAt: snapshot.updatedAt }
    })
    // Its revisions: drop the ones THIS file added, re-insert any original a test deleted.
    const keep = snapshotRevisions.map(r => r.id)
    const afterRevs = await db.select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, snapshot.id)))
    const toDelete = afterRevs.map(r => r.id).filter(id => !keep.includes(id))
    if (toDelete.length) await db.delete(agentConfigRevisions).where(inArray(agentConfigRevisions.id, toDelete))
    if (snapshotRevisions.length) await db.insert(agentConfigRevisions).values(snapshotRevisions).onConflictDoNothing()
  }
  // else: there was no row before this file ran — the loop above already removed everything
  // this file created, so the table is back to empty, matching the original (empty) state.
})

describe('profile store (server/services/profile.ts)', () => {
  // Task 2 review, fix round 1: agent_profile carries no unique constraint, so a plain
  // select-then-insert lazy-create can race concurrent first-ever calls into multiple rows.
  // getProfileSource() closes this with a pg_advisory_xact_lock-guarded re-select-then-insert
  // (server/services/profile.ts). A fan-out of 25 concurrent calls (not just 2) is what actually
  // exercises the race on a fast local Postgres: 2 calls over Promise.all were not enough to
  // reliably overlap in manual testing (BEGIN + re-select + INSERT + COMMIT for the first caller
  // often finished before the second's transaction even opened), but 25 reliably produced several
  // extra rows against the pre-fix code — see the mutation check in the report.
  it('25 concurrent getProfileSource() calls on an absent row produce exactly one row', async () => {
    await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.targetKind, 'profile'))
    await useDb().delete(agentProfile)

    const results = await Promise.all(Array.from({ length: 25 }, () => getProfileSource()))
    for (const r of results) expect(r.content).toBe('')
    // Every call must have resolved to the SAME row (same content/hash/updatedAt/updatedBy) —
    // two distinct rows would show up here as differing `updatedAt` values.
    expect(results).toEqual(results.map(() => results[0]))

    const rows = await useDb().select().from(agentProfile)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('')
  })

  it('lazily creates the row with empty content when none exists', async () => {
    // Clear the table for this assertion — already captured in `snapshot` for final restore.
    await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.targetKind, 'profile'))
    await useDb().delete(agentProfile)

    const source = await getProfileSource()
    expect(source.content).toBe('')
    expect(source.contentHash).toBe(hashOf(''))
    expect(source.updatedBy).toBe('human')

    // Idempotent: calling again reads the same row rather than creating a second one.
    const again = await getProfileSource()
    expect(again.contentHash).toBe(source.contentHash)
    const rows = await useDb().select().from(agentProfile)
    expect(rows).toHaveLength(1)
  })

  // Task 3 (ruled from the Task 2 review): saveProfileSource must create a missing row through the
  // same advisory-locked helper getProfileSource uses, not its own unguarded insert — otherwise
  // concurrent first-ever SAVES race into several rows just as concurrent reads once did.
  it('a first-ever save on an absent row creates exactly one row and records the revision', async () => {
    await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.targetKind, 'profile'))
    await useDb().delete(agentProfile)

    const saved = await saveProfileSource('First words.', hashOf(''), 'human')
    expect(saved).toMatchObject({ content: 'First words.', contentHash: hashOf('First words.'), updatedBy: 'human' })
    const rows = await useDb().select().from(agentProfile)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('First words.')
    const revs = await listProfileRevisions()
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ content: 'First words.', actor: 'human' })
  })

  it('a first-ever save with a hash other than the empty row\'s conflicts and writes nothing but the empty row', async () => {
    await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.targetKind, 'profile'))
    await useDb().delete(agentProfile)

    await expect(saveProfileSource('nope', 'stale', 'human')).rejects.toBeInstanceOf(ConflictError)
    const rows = await useDb().select().from(agentProfile)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('')
    expect(await listProfileRevisions()).toHaveLength(0)
  })

  it('25 concurrent first-ever saves on an absent row produce exactly one row; one wins, the rest conflict', async () => {
    await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.targetKind, 'profile'))
    await useDb().delete(agentProfile)

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => saveProfileSource(`save ${i}`, hashOf(''), 'human'))
    )
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    for (const r of lost) expect(r.reason).toBeInstanceOf(ConflictError)

    const rows = await useDb().select().from(agentProfile)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe((won[0] as PromiseFulfilledResult<{ content: string }>).value.content)
  })

  it('saves with the right hash: new hash plus a profile revision recorded with the actor', async () => {
    const before = await getProfileSource()
    const saved = await saveProfileSource('Tony likes short, direct answers.', before.contentHash, 'human')

    expect(saved.content).toBe('Tony likes short, direct answers.')
    expect(saved.contentHash).toBe(hashOf('Tony likes short, direct answers.'))
    expect(saved.contentHash).not.toBe(before.contentHash)

    const revs = await listProfileRevisions()
    expect(revs[0]).toMatchObject({ content: 'Tony likes short, direct answers.', actor: 'human', improvementId: null })
    expect(revs[0]!.createdAt).toBeInstanceOf(Date)
  })

  it('records the improvementId on the revision when supplied', async () => {
    const current = await getProfileSource()
    const improvementId = randomUUID()
    await saveProfileSource('Tony prefers bullet points.', current.contentHash, 'agent', { improvementId })

    const revs = await listProfileRevisions()
    expect(revs[0]).toMatchObject({ content: 'Tony prefers bullet points.', actor: 'agent', improvementId })
  })

  it('rejects a stale hash with ConflictError carrying the current content', async () => {
    const current = await getProfileSource()
    await expect(saveProfileSource('nope', 'not-the-real-hash', 'human')).rejects.toBeInstanceOf(ConflictError)
    try {
      await saveProfileSource('nope', 'not-the-real-hash', 'human')
      expect.unreachable('saveProfileSource should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).current).toEqual({ content: current.content, contentHash: current.contentHash })
    }
    // The stale write never landed.
    expect((await getProfileSource()).content).toBe(current.content)
  })

  it('revert restores the content and records a new revision', async () => {
    const beforeRevert = await listProfileRevisions()
    const targetRevision = beforeRevert.find(r => r.content === 'Tony likes short, direct answers.')
    expect(targetRevision).toBeDefined()

    // Move the profile away from the content we're about to revert to.
    const current = await getProfileSource()
    await saveProfileSource('Tony likes long, exhaustive answers now.', current.contentHash, 'human')
    expect((await getProfileSource()).content).toBe('Tony likes long, exhaustive answers now.')

    const reverted = await revertProfile(targetRevision!.id, 'human')
    expect(reverted.content).toBe('Tony likes short, direct answers.')
    expect((await getProfileSource()).content).toBe('Tony likes short, direct answers.')

    const afterRevert = await listProfileRevisions()
    expect(afterRevert.length).toBeGreaterThan(beforeRevert.length)
    expect(afterRevert[0]).toMatchObject({ content: 'Tony likes short, direct answers.', actor: 'human' })
  })

  it('revertProfile rejects an unknown revision id', async () => {
    await expect(revertProfile(randomUUID(), 'human')).rejects.toThrow(/does not belong to the profile/)
  })

  it('revertProfile rejects a revision id that exists but belongs to a different target', async () => {
    // A real agent_config_revisions row (so getRevision() finds it), deliberately under a
    // target_kind/target_id the profile does NOT own — proves the ownership check, not just
    // the not-found branch.
    const foreignTargetId = randomUUID()
    const [foreign] = await useDb().insert(agentConfigRevisions)
      .values({ targetKind: 'skill', targetId: foreignTargetId, content: 'not the profile', actor: 'human' })
      .returning()
    try {
      await expect(revertProfile(foreign!.id, 'human')).rejects.toThrow(/does not belong to the profile/)
    } finally {
      await useDb().delete(agentConfigRevisions).where(eq(agentConfigRevisions.id, foreign!.id))
    }
  })
})
