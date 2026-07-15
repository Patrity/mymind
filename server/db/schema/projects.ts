import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  color: text('color'),
  gitRemoteKey: text('git_remote_key'),
  repositoryUrl: text('repository_url'),
  productionUrl: text('production_url'),
  stagingUrl: text('staging_url'),
  aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  localPaths: text('local_paths').array().notNull().default(sql`'{}'::text[]`),
  pathPrefixes: text('path_prefixes').array().notNull().default(sql`'{}'::text[]`),
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('projects_slug_uidx').on(t.slug),
  index('projects_git_remote_key_idx').on(t.gitRemoteKey)
])

export type Project = typeof projects.$inferSelect
