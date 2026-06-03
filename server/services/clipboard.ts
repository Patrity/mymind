import { and, asc, eq, gt } from 'drizzle-orm'
import { useDb } from '../db'
import { clipThreads, clipMessages, clipAttachments, clipDevices } from '../db/schema'
import { sanitizeHtml } from '../../shared/utils/sanitize-html'

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export interface ClipThreadDTO {
  id: string
  userId: string | null
  title: string
  createdAt: string
  updatedAt: string
}

export interface ClipAttachmentDTO {
  id: string
  messageId: string
  storageKey: string
  sha256: string | null
  size: number
  mime: string | null
  originalName: string | null
  width: number | null
  height: number | null
}

export interface ClipMessageDTO {
  id: string
  threadId: string
  deviceId: string | null
  kind: string
  bodyText: string | null
  bodyHtml: string | null
  createdAt: string
  attachment?: ClipAttachmentDTO
}

export interface ClipDeviceDTO {
  id: string
  label: string | null
  lastSeenAt: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

function toThreadDTO(r: typeof clipThreads.$inferSelect): ClipThreadDTO {
  return {
    id: r.id,
    userId: r.userId ?? null,
    title: r.title,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }
}

function toAttachmentDTO(r: typeof clipAttachments.$inferSelect): ClipAttachmentDTO {
  return {
    id: r.id,
    messageId: r.messageId,
    storageKey: r.storageKey,
    sha256: r.sha256 ?? null,
    size: r.size,
    mime: r.mime ?? null,
    originalName: r.originalName ?? null,
    width: r.width ?? null,
    height: r.height ?? null
  }
}

function toMessageDTO(
  r: typeof clipMessages.$inferSelect,
  attachment?: typeof clipAttachments.$inferSelect
): ClipMessageDTO {
  const dto: ClipMessageDTO = {
    id: r.id,
    threadId: r.threadId,
    deviceId: r.deviceId ?? null,
    kind: r.kind,
    bodyText: r.bodyText ?? null,
    bodyHtml: r.bodyHtml ?? null,
    createdAt: r.createdAt.toISOString()
  }
  if (attachment) {
    dto.attachment = toAttachmentDTO(attachment)
  }
  return dto
}

function toDeviceDTO(r: typeof clipDevices.$inferSelect): ClipDeviceDTO {
  return {
    id: r.id,
    label: r.label ?? null,
    lastSeenAt: r.lastSeenAt.toISOString(),
    createdAt: r.createdAt.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export async function listThreads(): Promise<ClipThreadDTO[]> {
  const rows = await useDb()
    .select()
    .from(clipThreads)
    .orderBy(asc(clipThreads.createdAt))
  return rows.map(toThreadDTO)
}

export async function createThread(input: { title?: string; userId?: string } = {}): Promise<ClipThreadDTO> {
  const [row] = await useDb()
    .insert(clipThreads)
    .values({
      title: input.title ?? 'Clipboard',
      userId: input.userId ?? null
    })
    .returning()
  return toThreadDTO(row!)
}

export async function getThread(id: string): Promise<ClipThreadDTO | null> {
  const [row] = await useDb()
    .select()
    .from(clipThreads)
    .where(eq(clipThreads.id, id))
    .limit(1)
  return row ? toThreadDTO(row) : null
}

export async function renameThread(id: string, title: string): Promise<ClipThreadDTO | null> {
  const [row] = await useDb()
    .update(clipThreads)
    .set({ title, updatedAt: new Date() })
    .where(eq(clipThreads.id, id))
    .returning()
  return row ? toThreadDTO(row) : null
}

export async function deleteThread(id: string): Promise<boolean> {
  const db = useDb()

  // Fetch all messages in the thread so we can delete attachments
  const msgs = await db
    .select({ id: clipMessages.id })
    .from(clipMessages)
    .where(eq(clipMessages.threadId, id))

  if (msgs.length > 0) {
    const msgIds = msgs.map(m => m.id)
    // Delete attachments for each message
    for (const msgId of msgIds) {
      await db.delete(clipAttachments).where(eq(clipAttachments.messageId, msgId))
    }
    // Delete all messages
    await db.delete(clipMessages).where(eq(clipMessages.threadId, id))
  }

  const [deleted] = await db
    .delete(clipThreads)
    .where(eq(clipThreads.id, id))
    .returning({ id: clipThreads.id })
  return !!deleted
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(opts: {
  threadId: string
  since?: string
  limit?: number
}): Promise<ClipMessageDTO[]> {
  const db = useDb()
  const { threadId, since, limit = 100 } = opts

  // FIX 3: Guard against invalid `since` values (e.g. a UUID instead of an ISO
  // string). new Date(uuid) produces Invalid Date which causes Drizzle to throw.
  // Also add 1ms to the cursor: DTO ISO strings are truncated to milliseconds but
  // Postgres stores microseconds, so gt(createdAt, "...068Z") would still include
  // a row whose actual DB time is "...068768µs". Adding 1ms makes the cursor
  // exclusive at the millisecond boundary the caller observed.
  const sinceRaw = since ? new Date(since) : null
  const sinceDate = sinceRaw && !isNaN(sinceRaw.getTime())
    ? new Date(sinceRaw.getTime() + 1)
    : null
  const whereClause = sinceDate
    ? and(eq(clipMessages.threadId, threadId), gt(clipMessages.createdAt, sinceDate))
    : eq(clipMessages.threadId, threadId)

  const msgs = await db
    .select()
    .from(clipMessages)
    .where(whereClause)
    .orderBy(asc(clipMessages.createdAt))
    .limit(limit)

  if (msgs.length === 0) return []

  // Fetch attachments for file messages
  const fileMessageIds = msgs
    .filter(m => m.kind === 'file')
    .map(m => m.id)

  const attachmentsByMessageId = new Map<string, typeof clipAttachments.$inferSelect>()

  if (fileMessageIds.length > 0) {
    for (const msgId of fileMessageIds) {
      const [att] = await db
        .select()
        .from(clipAttachments)
        .where(eq(clipAttachments.messageId, msgId))
        .limit(1)
      if (att) attachmentsByMessageId.set(msgId, att)
    }
  }

  return msgs.map(m => toMessageDTO(m, attachmentsByMessageId.get(m.id)))
}

export async function createTextMessage(input: {
  threadId: string
  deviceId?: string
  bodyText?: string
  bodyHtml?: string
}): Promise<ClipMessageDTO> {
  const db = useDb()
  const sanitized = input.bodyHtml ? sanitizeHtml(input.bodyHtml) : undefined

  const [msg] = await db
    .insert(clipMessages)
    .values({
      threadId: input.threadId,
      deviceId: input.deviceId ?? null,
      kind: 'text',
      bodyText: input.bodyText ?? null,
      bodyHtml: sanitized ?? null
    })
    .returning()

  // Bump thread updatedAt
  await db
    .update(clipThreads)
    .set({ updatedAt: new Date() })
    .where(eq(clipThreads.id, input.threadId))

  return toMessageDTO(msg!)
}

export interface AttachmentInput {
  storageKey: string
  sha256?: string
  size: number
  mime?: string
  originalName?: string
  width?: number
  height?: number
}

export async function createFileMessage(input: {
  threadId: string
  deviceId?: string
  attachment: AttachmentInput
}): Promise<ClipMessageDTO> {
  const db = useDb()

  const [msg] = await db
    .insert(clipMessages)
    .values({
      threadId: input.threadId,
      deviceId: input.deviceId ?? null,
      kind: 'file'
    })
    .returning()

  const [att] = await db
    .insert(clipAttachments)
    .values({
      messageId: msg!.id,
      storageKey: input.attachment.storageKey,
      sha256: input.attachment.sha256 ?? null,
      size: input.attachment.size,
      mime: input.attachment.mime ?? null,
      originalName: input.attachment.originalName ?? null,
      width: input.attachment.width ?? null,
      height: input.attachment.height ?? null
    })
    .returning()

  // Bump thread updatedAt
  await db
    .update(clipThreads)
    .set({ updatedAt: new Date() })
    .where(eq(clipThreads.id, input.threadId))

  return toMessageDTO(msg!, att!)
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function registerDevice(label?: string): Promise<ClipDeviceDTO> {
  const [row] = await useDb()
    .insert(clipDevices)
    .values({ label: label ?? null })
    .returning()
  return toDeviceDTO(row!)
}

export async function touchDevice(id: string): Promise<ClipDeviceDTO | null> {
  const [row] = await useDb()
    .update(clipDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(clipDevices.id, id))
    .returning()
  return row ? toDeviceDTO(row) : null
}

export async function listDevices(): Promise<ClipDeviceDTO[]> {
  const rows = await useDb()
    .select()
    .from(clipDevices)
    .orderBy(asc(clipDevices.createdAt))
  return rows.map(toDeviceDTO)
}
