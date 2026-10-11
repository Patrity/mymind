import { sql } from 'drizzle-orm'
import { pgTable, bigserial, uuid, integer, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

/** Cycle 81 (spec §3.1): the worker → web half of the Postgres bus. Append-only; one row per hub
 *  frame (text/reasoning deltas coalesced ≈50ms per run before insert). The writer NOTIFYs
 *  `run_event` with `'<conversation_id>:<id>'` — a pointer, never the frame itself. */
export const runEvents = pgTable('run_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ns: text('ns').notNull().default('default'),  // bus namespace (lib/bus/ns.ts)
  // No FK to agent_runs: the log may outlive a pruned run row; retention prunes by run age.
  runId: uuid('run_id').notNull(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),                // per run, 1-based, gap-free per writer
  type: text('type').notNull(),                 // the frame's `type`
  payload: jsonb('payload').notNull(),          // the whole HubFrame
  onlySink: text('only_sink'),                  // origin-socket targeting (null = fan out)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq),
  index('run_events_conv_id_idx').on(t.ns, t.conversationId, t.id)
])

/** Cycle 81 (spec §3.2): the web → worker half. NOTIFY `worker_command` with `'<id>'` on insert;
 *  the worker also polls unhandled rows (missed-notify safety). A worker claims a row atomically
 *  (`claimed_at`) before running it, so notify + poll — or two workers during a deploy overlap —
 *  never run one command twice. A sender that gives up (timeout) closes an UNCLAIMED row itself
 *  (`handled_at` + a timeout result), so a late worker never executes a command the user was
 *  already told failed. */
export const workerCommands = pgTable('worker_commands', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ns: text('ns').notNull().default('default'),  // bus namespace — a worker only claims its own
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  result: jsonb('result')                       // CommandResult once handled
}, (t) => [
  index('worker_commands_pending_idx').on(t.ns, t.id).where(sql`handled_at is null and claimed_at is null`)
])

/** Cycle 81 (spec §6): one row per worker boot, `beat_at` refreshed every tick; the web shows
 *  "agent worker offline" when the newest beat is stale (> 30s). */
export const workerHeartbeat = pgTable('worker_heartbeat', {
  bootId: text('boot_id').primaryKey(),
  ns: text('ns').notNull().default('default'),  // the web reads only its own namespace's beats
  pid: integer('pid'),
  host: text('host'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull().defaultNow(),
  // Cycle 81 Task 2 fix: state only the worker knows, refreshed with every beat (WorkerBeatStatus,
  // lib/bus/commands.ts) — e.g. the iMessage catch-up health the web's Channels nav dot shows.
  status: jsonb('status')
}, (t) => [
  index('worker_heartbeat_ns_beat_idx').on(t.ns, t.beatAt)
])
