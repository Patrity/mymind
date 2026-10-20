import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'
import { tsvector } from '../types/tsvector'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  role: text('role'),
  content: text('content').notNull().default(''),
  externalUuid: text('external_uuid'),
  parentUuid: text('parent_uuid'),
  thinking: text('thinking'),
  model: text('model'),
  stopReason: text('stop_reason'),
  requestId: text('request_id'),
  isSidechain: boolean('is_sidechain').notNull().default(false),
  usage: jsonb('usage'),
  embedding: halfvec(2560),
  /** Lexical-lane source (migration 0090): maintained by Postgres, GIN-indexed, queried with
   *  websearch_to_tsquery — see lib/search/lexical.ts. */
  // `left(…, 200000)`: a tsvector is capped at 1 MB and messages carry arbitrarily large tool
  // output; ranking on the first 200k chars is plenty and the ILIKE fallback still sees the rest.
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', left(content, 200000))`),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('messages_session_idx').on(t.sessionId),
  // Home (cycle 56) and the Usage tab (cycle 55) both filter `created_at >= start`.
  // Without this it is a seq scan over ~147k prod rows on the landing page.
  index('messages_created_at_idx').on(t.createdAt.desc()),
  // Keyset pagination for the transcript (cycle 66) walks (session_id, created_at desc, id desc).
  // `messages_session_idx` alone leaves a 5,622-row session sorting on every page fetch.
  index('messages_session_created_idx').on(t.sessionId, t.createdAt.desc(), t.id.desc()),
  index('messages_tsv_gin').using('gin', t.tsv),
  uniqueIndex('messages_session_extuuid_uidx').on(t.sessionId, t.externalUuid)
])

export type Message = typeof messages.$inferSelect
