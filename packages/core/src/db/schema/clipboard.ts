import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'

export const clipThreads = pgTable('clip_threads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: text('user_id'),
  title: text('title').notNull().default('Clipboard'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const clipMessages = pgTable('clip_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  threadId: uuid('thread_id').notNull(),
  deviceId: uuid('device_id'),
  kind: text('kind').notNull().default('text'), // text | file
  bodyText: text('body_text'),
  bodyHtml: text('body_html'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('clip_messages_thread_idx').on(t.threadId, t.createdAt)
])

export const clipAttachments = pgTable('clip_attachments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  messageId: uuid('message_id').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256'),
  size: integer('size').notNull().default(0),
  mime: text('mime'),
  originalName: text('original_name'),
  width: integer('width'),
  height: integer('height')
})

export const clipDevices = pgTable('clip_devices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  label: text('label'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export type ClipThread = typeof clipThreads.$inferSelect
export type ClipMessage = typeof clipMessages.$inferSelect
export type ClipAttachment = typeof clipAttachments.$inferSelect
export type ClipDevice = typeof clipDevices.$inferSelect
