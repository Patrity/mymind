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
import { useDb } from '../server/db'
import { agentProfile, agentConfigRevisions, type AgentProfileRow } from '../server/db/schema'
import { getProfileSource, saveProfileSource, listProfileRevisions, revertProfile } from '../server/services/profile'
import { ConflictError } from '../server/services/skills'

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex')

let snapshot: AgentProfileRow | null = null
let beforeRevisionIds: string[] = []

beforeAll(async () => {
  const rows = await useDb().select().from(agentProfile)
  snapshot = rows[0] ?? null
  if (snapshot) {
    const revs = await useDb().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, snapshot.id)))
    beforeRevisionIds = revs.map(r => r.id)
  }
})

afterAll(async () => {
  const db = useDb()
  // Remove every profile row this file created (there is only ever meant to be one, but be
  // defensive) other than the original snapshot's row.
  const rows = await db.select().from(agentProfile)
  for (const row of rows) {
    if (!snapshot || row.id !== snapshot.id) {
      await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, row.id)))
      await db.delete(agentProfile).where(eq(agentProfile.id, row.id))
    }
  }
  if (snapshot) {
    // Restore the original row byte-for-byte.
    await db.update(agentProfile).set({
      content: snapshot.content, contentHash: snapshot.contentHash,
      updatedBy: snapshot.updatedBy, updatedAt: snapshot.updatedAt
    }).where(eq(agentProfile.id, snapshot.id))
    // Delete only the revisions THIS file created (i.e. not present before beforeAll ran).
    const afterRevs = await db.select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'profile'), eq(agentConfigRevisions.targetId, snapshot.id)))
    const toDelete = afterRevs.map(r => r.id).filter(id => !beforeRevisionIds.includes(id))
    if (toDelete.length) await db.delete(agentConfigRevisions).where(inArray(agentConfigRevisions.id, toDelete))
  }
  // else: there was no row before this file ran — the loop above already removed everything
  // this file created, so the table is back to empty, matching the original (empty) state.
})

describe('profile store (server/services/profile.ts)', () => {
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
