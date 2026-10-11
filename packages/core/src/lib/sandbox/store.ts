// Cycle 82 (spec §3): the workspaces table. The sandbox manager talks to it through the
// `WorkspaceStore` interface (unit tests use an in-memory one); `dbWorkspaceStore` is the real one.
// Every write publishes the live `workspace` resource.
import { and, eq, isNull, isNotNull, lt, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { workspaces, type WorkspaceRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'

export type { WorkspaceRow }

export interface WorkspaceStore {
  get(id: string): Promise<WorkspaceRow | null>
  /** Record the container (or none) and whether it runs. */
  setContainer(id: string, containerId: string | null, state: WorkspaceRow['state']): Promise<void>
  /** last_used_at = now (every command). */
  touch(id: string): Promise<void>
  setUsage(id: string, bytes: number, inodes: number): Promise<void>
  /** Persistent taint on/off (review I1). */
  setTainted(id: string, tainted: boolean): Promise<void>
  /** Live rows the DB believes are running. */
  listRunning(): Promise<WorkspaceRow[]>
  /** Workstream workspaces whose workstream is gone get `deleted_at` (the 30-day clock starts). */
  stampOrphans(): Promise<number>
  /** Rows deleted before `before` (their container + dir go, then the row). */
  listExpired(before: Date): Promise<WorkspaceRow[]>
  remove(id: string): Promise<void>
}

function publish(id: string, action: 'created' | 'updated' | 'deleted' = 'updated'): void {
  publishChange({ resource: 'workspace', action, id })
}

export const dbWorkspaceStore: WorkspaceStore = {
  async get(id) {
    const [r] = await useDb().select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
    return r ?? null
  },
  // Change-only (Task 3): ensureContainer records the container on EVERY command, and the Files /
  // Shells UI refetches on each `workspace` event — an unconditional publish made each UI read
  // trigger the next one (a refetch loop), and spammed the live bus during agent runs.
  async setContainer(id, containerId, state) {
    const changed = await useDb().update(workspaces).set({ containerId, state })
      .where(and(eq(workspaces.id, id), sql`(${workspaces.containerId} is distinct from ${containerId}::text or ${workspaces.state} <> ${state}::text)`))
      .returning({ id: workspaces.id })
    if (changed.length) publish(id)
  },
  async touch(id) {
    await useDb().update(workspaces).set({ lastUsedAt: new Date() }).where(eq(workspaces.id, id))
  },
  async setUsage(id, bytes, inodes) {
    const changed = await useDb().update(workspaces).set({ bytesUsed: bytes, inodesUsed: inodes })
      .where(and(eq(workspaces.id, id), sql`(${workspaces.bytesUsed} <> ${bytes}::bigint or ${workspaces.inodesUsed} <> ${inodes}::int)`))
      .returning({ id: workspaces.id })
    if (changed.length) publish(id)
  },
  async setTainted(id, tainted) {
    await useDb().update(workspaces).set(tainted ? { tainted: true, taintedAt: new Date() } : { tainted: false, taintedAt: null }).where(eq(workspaces.id, id))
    publish(id)
  },
  async listRunning() {
    return useDb().select().from(workspaces).where(and(eq(workspaces.state, 'running'), isNull(workspaces.deletedAt)))
  },
  async stampOrphans() {
    const rows = await useDb().update(workspaces).set({ deletedAt: new Date() })
      .where(and(eq(workspaces.kind, 'workstream'), isNull(workspaces.workstreamId), isNull(workspaces.deletedAt)))
      .returning({ id: workspaces.id })
    for (const r of rows) publish(r.id)
    return rows.length
  },
  async listExpired(before) {
    return useDb().select().from(workspaces).where(and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, before)))
  },
  async remove(id) {
    await useDb().delete(workspaces).where(eq(workspaces.id, id))
    publish(id, 'deleted')
  }
}

/** The single live chat `home` workspace (created on first use; race-safe via the partial unique index). */
export async function ensureHomeWorkspace(): Promise<WorkspaceRow> {
  const db = useDb()
  const find = async () => (await db.select().from(workspaces).where(and(eq(workspaces.kind, 'home'), isNull(workspaces.deletedAt))).limit(1))[0]
  const existing = await find()
  if (existing) return existing
  const [created] = await db.insert(workspaces).values({ kind: 'home' })
    .onConflictDoNothing({ target: workspaces.kind, where: sql`${workspaces.kind} = 'home' and ${workspaces.deletedAt} is null` })
    .returning()
  if (created) { publish(created.id, 'created'); return created }
  const raced = await find()
  if (!raced) throw new Error('home workspace: insert conflicted but no row found')
  return raced
}

/** A workstream's workspace (one per workstream; created at its start). */
export async function ensureWorkstreamWorkspace(workstreamId: string): Promise<WorkspaceRow> {
  const db = useDb()
  const [created] = await db.insert(workspaces).values({ kind: 'workstream', workstreamId })
    .onConflictDoNothing({ target: workspaces.workstreamId, where: sql`${workspaces.workstreamId} is not null` })
    .returning()
  if (created) { publish(created.id, 'created'); return created }
  const [row] = await db.select().from(workspaces).where(eq(workspaces.workstreamId, workstreamId)).limit(1)
  if (!row) throw new Error(`workstream ${workstreamId}: workspace insert conflicted but no row found`)
  return row
}

