import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  path: text('path').notNull(),
  title: text('title'),
  content: text('content').notNull().default(''),
  language: text('language').notNull().default('plaintext'),
  frontmatter: jsonb('frontmatter').notNull().default(sql`'{}'::jsonb`),
  project: text('project'),
  projectId: uuid('project_id'),
  domain: text('domain'),
  type: text('type'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  topic: text('topic'), // ltree column; declared as text in drizzle, altered to ltree in custom SQL
  contentHash: text('content_hash'),
  embeddedHash: text('embedded_hash'),
  isPublic: boolean('is_public').notNull().default(false),
  publicSlug: text('public_slug'),
  ocrId: uuid('ocr_id'),
  embedding: halfvec(2560), // schema only in cycle 1; stays null
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => ({
  pathUnique: uniqueIndex('documents_path_live_uidx').on(t.path).where(sql`${t.deletedAt} is null`),
  publicSlugUnique: uniqueIndex('documents_public_slug_uidx').on(t.publicSlug),
  tagsIdx: index('documents_tags_gin').using('gin', t.tags),
  projectIdx: index('documents_project_idx').on(t.project),
  projectIdIdx: index('documents_project_id_idx').on(t.projectId)
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
