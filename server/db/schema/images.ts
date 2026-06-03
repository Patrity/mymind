import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const images = pgTable('images', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  storageKey: text('storage_key').notNull(),
  originalName: text('original_name'),
  mime: text('mime').notNull(),
  ext: text('ext').notNull(),
  kind: text('kind').notNull().default('image'), // image | gif | video
  width: integer('width'),
  height: integer('height'),
  size: integer('size').notNull(),
  ocrText: text('ocr_text'),
  ocrAttempts: integer('ocr_attempts').notNull().default(0),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  recommendedTags: text('recommended_tags').array().notNull().default(sql`'{}'::text[]`),
  isPublic: boolean('is_public').notNull().default(false),
  publicSlug: text('public_slug'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (t) => ({
  publicSlugUnique: uniqueIndex('images_public_slug_uidx').on(t.publicSlug),
  tagsIdx: index('images_tags_gin').using('gin', t.tags)
}))

export type Image = typeof images.$inferSelect
export type NewImage = typeof images.$inferInsert
