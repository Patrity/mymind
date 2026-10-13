// Cycle 82 (spec §3): the workspaces table. The sandbox manager talks to it through the
// `WorkspaceStore` interface (unit tests use an in-memory one); `dbWorkspaceStore` is the real one.
// Every write publishes the live `workspace` resource.
import { and, eq, inArray, isNull, isNotNull, lt, or, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { workspaces, workstreams, type WorkspaceRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { busNs } from '../bus/ns'

export type { WorkspaceRow }

export interface WorkspaceStore {
  get(id: string): Promise<WorkspaceRow | null>
  /** Record whether the workspace is in use (`running`: used since its last idle/teardown stop).
   *  `containerId` is cycle 82's; the host runtime always passes null. */
  setContainer(id: string, containerId: string | null, state: WorkspaceRow['state']): Promise<void>
  /** last_used_at = now (every command). */
  touch(id: string): Promise<void>
  setUsage(id: string, bytes: number, inodes: number): Promise<void>
  /** Persistent taint on/off (review I1). */
  setTainted(id: string, tainted: boolean): Promise<void>
  /** Live rows the DB believes are running (this bus namespace's — final fix wave). */
  listRunning(): Promise<WorkspaceRow[]>
  /** Workstream workspaces whose workstream is gone get `deleted_at` (the 30-day clock starts). */
  stampOrphans(): Promise<number>
  /** Rows whose 30-day clock ran out before `before` (their dir goes, then the row):
   *  deleted before it, or (final review I7) the workspace of a workstream that FINISHED (done /
   *  failed / cancelled) before it. A resumed workstream has no finished_at, so it is never swept. */
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
  // Change-only (Task 3): a command may record the state on every call, and the Files /
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
    return useDb().select().from(workspaces).where(and(eq(workspaces.state, 'running'), isNull(workspaces.deletedAt), eq(workspaces.ns, busNs())))
  },
  async stampOrphans() {
    const rows = await useDb().update(workspaces).set({ deletedAt: new Date() })
      .where(and(eq(workspaces.kind, 'workstream'), isNull(workspaces.workstreamId), isNull(workspaces.deletedAt), eq(workspaces.ns, busNs())))
      .returning({ id: workspaces.id })
    for (const r of rows) publish(r.id)
    return rows.length
  },
  async listExpired(before) {
    const finished = useDb().select({ id: workstreams.id }).from(workstreams)
      .where(and(inArray(workstreams.state, ['done', 'failed', 'cancelled']), isNotNull(workstreams.finishedAt), lt(workstreams.finishedAt, before)))
    return useDb().select().from(workspaces).where(and(eq(workspaces.ns, busNs()), or(
      and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, before)),
      and(eq(workspaces.kind, 'workstream'), inArray(workspaces.workstreamId, finished))
    )))
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
  const [created] = await db.insert(workspaces).values({ kind: 'home', ns: busNs() })
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
  const [created] = await db.insert(workspaces).values({ kind: 'workstream', workstreamId, ns: busNs() })
    .onConflictDoNothing({ target: workspaces.workstreamId, where: sql`${workspaces.workstreamId} is not null` })
    .returning()
  if (created) { publish(created.id, 'created'); return created }
  const [row] = await db.select().from(workspaces).where(eq(workspaces.workstreamId, workstreamId)).limit(1)
  if (!row) throw new Error(`workstream ${workstreamId}: workspace insert conflicted but no row found`)
  return row
}


/** Cycle 86 (option C): Tony marks a TAINTED workspace trusted — web session only (the route's
 *  requireSession; never the agent, an API token or /api/mcp). Clears `tainted` / `tainted_at`, so
 *  runs that read from it are no longer treated as having read untrusted content (their outbound
 *  tools stop needing approval on its account), and records a `workspace:trusted` activity row.
 *  A workstream's OWN sticky taint (workstreams.tainted) is untouched. Idempotent: an untainted
 *  workspace is returned as is, with no activity row. Null: no such live workspace. */
export async function markWorkspaceTrusted(
  id: string,
  deps: { record?: (e: { kind: 'tool'; name: string; severity: 'info'; meta: Record<string, unknown> }) => void } = {}
): Promise<WorkspaceRow | null> {
  const [cleared] = await useDb().update(workspaces).set({ tainted: false, taintedAt: null })
    .where(and(eq(workspaces.id, id), eq(workspaces.tainted, true), isNull(workspaces.deletedAt)))
    .returning()
  if (!cleared) {
    const [row] = await useDb().select().from(workspaces).where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt))).limit(1)
    return row ?? null
  }
  publish(id)
  const record = deps.record ?? ((e) => { void import('../observability/record').then(m => m.recordEvent(e)).catch(() => { /* best-effort */ }) })
  record({ kind: 'tool', name: 'workspace:trusted', severity: 'info', meta: { workspaceId: id, kind: cleared.kind, ...(cleared.workstreamId ? { workstreamId: cleared.workstreamId } : {}) } })
  return cleared
}
