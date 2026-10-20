import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { halfvec } from '../types/halfvec'
import { tsvector } from '../types/tsvector'

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sourceType: text('source_type').notNull(),       // 'document' | 'image'
  sourceId: uuid('source_id').notNull(),
  ord: integer('ord').notNull(),
  content: text('content').notNull(),              // raw chunk text — the returned passage
  context: text('context'),                        // LLM situating sentence (nullable)
  headingPath: text('heading_path'),               // 'Title › H1 › H2' breadcrumb
  tokenCount: integer('token_count'),
  charStart: integer('char_start'),
  charEnd: integer('char_end'),
  embedding: halfvec(2560),
  embeddedTextHash: text('embedded_text_hash'),
  /** Lexical-lane source (migration 0090): maintained by Postgres, GIN-indexed, queried with
   *  websearch_to_tsquery — see lib/search/lexical.ts. */
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(context, '') || ' ' || content)`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  sourceOrdUnique: uniqueIndex('chunks_source_ord_uidx').on(t.sourceType, t.sourceId, t.ord),
  tsvIdx: index('chunks_tsv_gin').using('gin', t.tsv),
  sourceIdx: index('chunks_source_idx').on(t.sourceType, t.sourceId)
  // HNSW index on embedding is added by hand in the migration (opclass not expressible in drizzle).
}))

export type Chunk = typeof chunks.$inferSelect
export type NewChunk = typeof chunks.$inferInsert
