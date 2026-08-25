import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * A folder in the document tree.
 *
 * Folders used to be derived entirely from `documents.path` prefixes, which meant they had
 * no identity and ceased to exist when their last document left. This table gives them one.
 * `documents.path` is still the source of truth for WHERE a document lives — a row here does
 * not own its documents, it records that the folder exists and what colour it is.
 *
 * A row is materialized (`ensureFolders`) the first time any writer puts a document under the
 * path, so the registry is complete rather than only covering folders the user hand-created.
 * No `deleted_at`: this is metadata, not content — the documents carry their own soft delete.
 */
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // Absolute, no trailing slash: '/projects/mymind/wiki'. The root is never a row.
  path: text('path').notNull(),
  // Hex from FOLDER_PALETTE, or null to inherit from the parent / owning project.
  color: text('color'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  uniqueIndex('folders_path_uidx').on(t.path)
])

export type Folder = typeof folders.$inferSelect
