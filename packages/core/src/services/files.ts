import { eq } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { useDb } from '../db'
import { agentFiles } from '../db/schema'
import { storage } from '../utils/storage'

export async function saveFile(
  buffer: Buffer,
  mime: string,
  name?: string
): Promise<{ id: string; mime: string; name?: string; size: number }> {
  const stream = Readable.from(buffer)
  const { key, size } = await storage().put(stream, { contentType: mime })
  const [row] = await useDb()
    .insert(agentFiles)
    .values({ storageKey: key, mime, name: name ?? null, size })
    .returning()
  return { id: row!.id, mime, name, size }
}

export async function getFileBytes(
  id: string
): Promise<{ bytes: Buffer; mime: string; name?: string } | null> {
  const [row] = await useDb()
    .select()
    .from(agentFiles)
    .where(eq(agentFiles.id, id))
    .limit(1)
  if (!row) return null
  const { stream } = await storage().get(row.storageKey)
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
  return { bytes: Buffer.concat(chunks), mime: row.mime, name: row.name ?? undefined }
}
