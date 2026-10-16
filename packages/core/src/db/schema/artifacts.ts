// Cycle 87 (spec §3): artifacts — Bridget's published static pages/webapps.
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex, index, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { conversations } from './conversations'
import type { Manifest } from '../../lib/artifacts/limits'

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  isPublic: boolean('is_public').notNull().default(false),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => artifactVersions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, t => ({
  slugLive: uniqueIndex('artifacts_slug_live_uidx').on(t.slug).where(sql`deleted_at is null`),
  project: index('artifacts_project_idx').on(t.projectId)
}))

export const artifactVersions = pgTable('artifact_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  artifactId: uuid('artifact_id').notNull().references((): AnyPgColumn => artifacts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  manifest: jsonb('manifest').$type<Manifest>().notNull(),
  entry: text('entry').notNull().default('index.html'),
  spaFallback: boolean('spa_fallback').notNull().default(false),
  totalBytes: integer('total_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => ({
  artifactVersion: uniqueIndex('artifact_versions_artifact_version_uidx').on(t.artifactId, t.version)
}))

export type Artifact = typeof artifacts.$inferSelect
export type NewArtifact = typeof artifacts.$inferInsert
export type ArtifactVersion = typeof artifactVersions.$inferSelect
export type NewArtifactVersion = typeof artifactVersions.$inferInsert
