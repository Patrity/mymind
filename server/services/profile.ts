// server/services/profile.ts
// Cycle 76, Task 2: the "About Tony" profile — a SINGLE-ROW markdown config (agent_profile),
// same CAS + revision pattern as a skill (server/services/skills.ts) but with no slug: there is
// exactly one row, created lazily on first read. Revisions reuse agent_config_revisions with
// target_kind = 'profile' (Task 1) — target_id is that one row's id.
//
// NOTE: this is UNRELATED to server/lib/agent/profile.ts's `AgentProfile` (Bridget's tool
// profile — personaKey/tools). Same English word, two different concepts; this file is the
// "About Tony" content Task 1's spec calls the profile.
import { createHash } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { agentProfile, type AgentProfileRow } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { recordRevision, listRevisions, getRevision, type RevisionActor } from '../lib/agent/config/revisions'
import { ConflictError } from './skills'

export interface ProfileSource { content: string; contentHash: string; updatedBy: string; updatedAt: string }

const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

// Fixed advisory-lock key serializing the agent_profile lazy-create race (Task 2 review, fix
// round 1) — distinct from jobs/store.ts's MAX_ENABLED_LOCK_KEY (740_450_001); must never collide
// with another pg_advisory_xact_lock key in this codebase.
const PROFILE_ROW_LOCK_KEY = 740_450_002

function rowToSource(row: AgentProfileRow): ProfileSource {
  return { content: row.content, contentHash: row.contentHash, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() }
}

// Anything with the drizzle query surface (the pool or an open transaction) — same shape as
// revisions.ts's Executor, plus `select` since currentRow reads.
type Executor = Pick<ReturnType<typeof useDb>, 'select' | 'insert' | 'execute'>

/** The one profile row, if it has ever been created. Deterministic tie-break (oldest by
 *  updated_at, then by id) in case more than one somehow exists — there is no unique constraint
 *  enforcing the singleton, only the advisory-lock guard in getProfileSource(). */
async function currentRow(db: Executor = useDb()): Promise<AgentProfileRow | null> {
  const [row] = await db.select().from(agentProfile)
    .orderBy(asc(agentProfile.updatedAt), asc(agentProfile.id))
    .limit(1)
  return row ?? null
}

/**
 * Reads the profile, creating the single row lazily with empty content on first call.
 *
 * Race guard (Task 2 review, fix round 1): two concurrent first-ever calls could otherwise both
 * see "no row" from the plain select above and each INSERT one, since agent_profile carries no
 * unique constraint. The miss falls into a transaction that takes a fixed pg_advisory_xact_lock,
 * re-selects under that lock, and only inserts if the re-select STILL finds nothing — so at most
 * one caller ever creates the row; every other concurrent caller's re-select finds the winner's
 * row instead.
 */
export async function getProfileSource(): Promise<ProfileSource> {
  const row = await currentRow()
  if (row) return rowToSource(row)
  return useDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_ROW_LOCK_KEY})`)
    const again = await currentRow(tx)
    if (again) return rowToSource(again)
    const content = ''
    const [inserted] = await tx.insert(agentProfile).values({ content, contentHash: hashOf(content) }).returning()
    return rowToSource(inserted!)
  })
}

/**
 * Compare-and-swap write of the profile's whole markdown. `expectedHash` is the contentHash the
 * editor loaded; a mismatch throws ConflictError(current) — including when the row does not
 * exist yet, in which case "current" is the lazily-created empty row's would-be hash (the same
 * hash getProfileSource() would have handed out).
 */
export async function saveProfileSource(
  content: string, expectedHash: string, actor: RevisionActor, opts: { improvementId?: string } = {}
): Promise<ProfileSource> {
  const db = useDb()
  const existing = await currentRow()
  let row: AgentProfileRow | undefined
  if (!existing) {
    const emptyHash = hashOf('')
    if (expectedHash !== emptyHash) throw new ConflictError({ content: '', contentHash: emptyHash })
    ;[row] = await db.insert(agentProfile).values({ content, contentHash: hashOf(content), updatedBy: actor }).returning()
  } else {
    if (existing.contentHash !== expectedHash) {
      throw new ConflictError({ content: existing.content, contentHash: existing.contentHash })
    }
    // Re-checked IN the UPDATE so a write landing between the read above and this statement
    // still loses rather than being clobbered (same race guard as saveSkillSource).
    ;[row] = await db.update(agentProfile)
      .set({ content, contentHash: hashOf(content), updatedBy: actor, updatedAt: new Date() })
      .where(and(eq(agentProfile.id, existing.id), eq(agentProfile.contentHash, expectedHash)))
      .returning()
    if (!row) {
      const now = await currentRow()
      throw new ConflictError({ content: now?.content ?? '', contentHash: now?.contentHash ?? '' })
    }
  }
  await recordRevision({ targetKind: 'profile', targetId: row!.id, content, actor, improvementId: opts.improvementId ?? null })
  publishChange({ resource: 'agentProfile', action: existing ? 'updated' : 'created', id: row!.id })
  return rowToSource(row!)
}

export async function listProfileRevisions(): Promise<{ id: string; content: string; actor: string; createdAt: Date; improvementId: string | null }[]> {
  const row = await currentRow()
  if (!row) return []
  const revs = await listRevisions('profile', row.id)
  return revs.map(r => ({ id: r.id, content: r.content, actor: r.actor, createdAt: new Date(r.createdAt), improvementId: r.improvementId }))
}

/** Restores the profile to one of its revisions (recorded as a NEW revision by `actor`). */
export async function revertProfile(revisionId: string, actor: RevisionActor): Promise<ProfileSource> {
  const row = await currentRow()
  if (!row) throw new Error('no profile row yet')
  const rev = await getRevision(revisionId)
  if (!rev || rev.targetKind !== 'profile' || rev.targetId !== row.id) {
    throw new Error(`revision ${revisionId} does not belong to the profile`)
  }
  return saveProfileSource(rev.content, row.contentHash, actor)
}
