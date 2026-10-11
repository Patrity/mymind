import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
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
