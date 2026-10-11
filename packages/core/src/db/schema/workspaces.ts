import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, bigint, integer, boolean, timestamp, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core'
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

/** Cycle 82 Task 2: a background shell (`bash` with run_in_background) — the per-workspace
 *  registry. The process runs inside the workspace's sandbox under `setsid`, writing to
 *  `/workspace/.mymind/shells/<id>/` (out, pid, exit); the worker reads that back incrementally
 *  (`read_offset`). A worker restart does not stop the sandbox, so a running shell is re-attached at
 *  boot; one whose sandbox or process is gone without an exit code is marked `lost`. */
export const workspaceShells = pgTable('workspace_shells', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  command: text('command').notNull(),
  state: text('state').notNull().default('running').$type<'running' | 'exited' | 'killed' | 'lost'>(),
  exitCode: integer('exit_code'),
  /** Why it ended when that was not its own exit (killed by whom / lost how). */
  reason: text('reason'),
  /** Bytes of `out` already returned by bash_output. */
  readOffset: bigint('read_offset', { mode: 'number' }).notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true })
}, (t) => [
  index('workspace_shells_ws_idx').on(t.workspaceId, t.state)
])
export type WorkspaceShellRow = typeof workspaceShells.$inferSelect

export type WatchUntil = { kind: 'exit0' } | { kind: 'match'; pattern: string }

/** Cycle 82 Task 2: a `watch` — a command the worker re-runs in the sandbox every `interval_sec`
 *  until it exits 0 / its output matches, or `deadline_at` passes. Persisted so a worker restart
 *  re-arms it. When it ends it wakes its workstream (or notes into the chat it came from). */
export const workspaceWatches = pgTable('workspace_watches', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The workstream to wake (null = a chat/home watch: `conversation_id` gets a note). */
  workstreamId: uuid('workstream_id'),
  conversationId: uuid('conversation_id'),
  command: text('command').notNull(),
  until: jsonb('until').notNull().$type<WatchUntil>(),
  intervalSec: integer('interval_sec').notNull(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  state: text('state').notNull().default('armed').$type<'armed' | 'met' | 'timeout' | 'cancelled' | 'failed'>(),
  polls: integer('polls').notNull().default(0),
  lastExitCode: integer('last_exit_code'),
  /** Tail of the last poll's output (≤ 4 KB). */
  lastOutput: text('last_output'),
  reason: text('reason'),
  /** What its owner is told (written when it ends). */
  resultText: text('result_text'),
  /** When that reached the owner — a workstream picks up an undelivered result at its next segment
   *  boundary (never mid-segment: a mid-turn event row would fork the thread); null = pending. */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true })
}, (t) => [
  index('workspace_watches_state_idx').on(t.state),
  index('workspace_watches_ws_idx').on(t.workspaceId, t.state)
])
export type WorkspaceWatchRow = typeof workspaceWatches.$inferSelect
