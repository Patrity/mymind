import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, real, jsonb, timestamp, index, uniqueIndex, boolean, integer, check } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scope: text('scope').notNull().default('user'),          // user | agent | world
  content: text('content').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  source: text('source'),
  embedding: halfvec(2560),
  contentHash: text('content_hash').notNull(),
  confidence: real('confidence'),
  /** Does this fact travel across projects? `project` above records where it was LEARNED
   *  (provenance); this records where it APPLIES. Retrieval ORs them together. */
  applicability: text('applicability').notNull().default('project'),
  /** In EVERY prompt. A much smaller set than `applicability='global'` — collapsing the two
   *  either starves the global tier or blows the context budget. */
  resident: boolean('resident').notNull().default(false),
  /** How often this memory has entered an assembled context, and when it last did.
   *  Written batched by the assembler; feeds resident self-nomination. */
  retrievalCount: integer('retrieval_count').notNull().default(0),
  lastRetrievedAt: timestamp('last_retrieved_at', { withTimezone: true }),
  /** Jev's independent read of this memory — a SECOND opinion beside `confidence`, which is
   *  the enrichment writer grading its own work. Same orientation: higher means more likely
   *  worth keeping. Null = not scored yet (unknown, NOT bad — see compareByJev). */
  jevScore: real('jev_score'),
  /** The raw Noul answers. Kept so a better weighting is a recompute rather than 2,600 more
   *  API calls — see server/lib/memory/jev-score.ts. */
  jevAnswers: jsonb('jev_answers'),
  jevScoredAt: timestamp('jev_scored_at', { withTimezone: true }),
  /** The model version that ANSWERED, not the one requested — the config asks for
   *  `jev-latest` and the API reports back which version resolved to. Stored per row so a
   *  later calibration can segment by version instead of assuming one. */
  jevModel: text('jev_model'),
  evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
  project: text('project'),
  projectId: uuid('project_id'),
  sourceDate: timestamp('source_date', { withTimezone: true }),
  sessionId: uuid('session_id'),
  supersededBy: uuid('superseded_by'),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true })
}, (t) => [
  index('memories_scope_idx').on(t.scope),
  index('memories_tags_gin').using('gin', t.tags),
  uniqueIndex('memories_content_hash_live_uidx').on(t.contentHash).where(sql`${t.archivedAt} is null`),
  index('memories_project_id_idx').on(t.projectId),
  check('memories_resident_implies_global', sql`not ${t.resident} or ${t.applicability} = 'global'`),
  index('memories_resident_idx').on(t.resident).where(sql`${t.resident}`)
])

export type Memory = typeof memories.$inferSelect
