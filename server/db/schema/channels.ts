import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { agentRuns } from './agent-runs'
import { agentJobs } from './agent-config'

/** Cycle 75: the delivery outbox. One row per outbound iMessage/email send — a job's reply,
 *  a tool-initiated send_message, or a headless run's queued reply-to-phone. `source` records
 *  who asked (used by send_message's rate limit); `firstClaimedAt` is the window a retry checks
 *  for an already-sent duplicate before resending (Review Focus 4). */
export const channelDeliveries = pgTable('channel_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: text('channel').notNull(),              // 'imessage' | 'email'
  target: text('target').notNull(),                // chat GUID or email address
  conversationId: uuid('conversation_id'),
  messageId: uuid('message_id'),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  source: text('source').notNull().default('reply'), // 'reply' | 'job' | 'tool' | 'note'
  payload: jsonb('payload').notNull(),             // { text, images?: string[], subject? }
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  firstClaimedAt: timestamp('first_claimed_at', { withTimezone: true }),
  lastError: text('last_error'),
  externalId: text('external_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true })
}, t => [
  index('channel_deliveries_due_idx').on(t.status, t.nextAttemptAt),
  index('channel_deliveries_message_idx').on(t.messageId),
  // 0058: GET /api/conversations/:id/deliveries (re-read by every open /agent tab on each
  // delivery event) filters on it.
  index('channel_deliveries_conversation_idx').on(t.conversationId)
])

/** Inbound dedupe: a primary-key insert on `guid` in the enqueue transaction decides which of
 *  webhook-vs-catch-up wins when the same message arrives both ways at once (Review Focus 3). */
export const channelInbound = pgTable('channel_inbound', {
  guid: text('guid').primaryKey(),
  channel: text('channel').notNull(),
  sender: text('sender').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  runId: uuid('run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [index('channel_inbound_received_idx').on(t.channel, t.receivedAt)])

/** Tapback (or reply) approvals for a run awaiting Tony's go-ahead over iMessage.
 *  `chatGuid` holds where the prompt was sent. */
export const channelApprovals = pgTable('channel_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  request: jsonb('request').notNull(),
  chatGuid: text('chat_guid').notNull(),
  promptGuid: text('prompt_guid'),
  status: text('status').notNull().default('pending'), // pending | approved | denied | expired
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [index('channel_approvals_prompt_idx').on(t.promptGuid)])

export type ChannelDelivery = typeof channelDeliveries.$inferSelect
export type ChannelApproval = typeof channelApprovals.$inferSelect
