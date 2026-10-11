import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, bigint, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { workstreams } from './workstreams'

/** Cycle 82 (spec §3): a sandboxed workspace — one per workstream plus one persistent chat `home`.
 *  Its files live in `<SANDBOX_WORKSPACES_DIR>/<id>` (bind-mounted at /workspace in its Docker
 *  sandbox, lib/sandbox/manager.ts); the row tracks the container and usage. Deleting the
 *  workstream nulls `workstream_id`; the daily sweep then stamps `deleted_at` and removes the
 *  container + dir 30 days later. */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  kind: text('kind').notNull().$type<'workstream' | 'home'>(),
  workstreamId: uuid('workstream_id').references(() => workstreams.id, { onDelete: 'set null' }),
  /** The docker container id while one exists (running or stopped); null = none created yet. */
  containerId: text('container_id'),
  state: text('state').notNull().default('stopped').$type<'stopped' | 'running'>(),
  /** Last measured size of the workspace dir (du inside the sandbox). */
  bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
  /** Last measured file count (inodes) of the workspace dir — quota'd too (review I2). */
  inodesUsed: integer('inodes_used').notNull().default(0),
  /** Persistent taint (review I1 ruling): set the first time a tainted run executes a command here.
   *  From then on EVERY command runs `--network none` without secrets, and the networked container
   *  stays stopped, until Tony re-enables the network (session-only API). */
  tainted: boolean('tainted').notNull().default(false),
  taintedAt: timestamp('tainted_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => [
  uniqueIndex('workspaces_workstream_idx').on(t.workstreamId).where(sql`${t.workstreamId} is not null`),
  // Exactly one live home workspace.
  uniqueIndex('workspaces_home_idx').on(t.kind).where(sql`${t.kind} = 'home' and ${t.deletedAt} is null`),
  index('workspaces_state_idx').on(t.state, t.lastUsedAt)
])

export type WorkspaceRow = typeof workspaces.$inferSelect
