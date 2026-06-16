import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { messages } from '../db/schema'
import { embed } from '../lib/ai/embeddings'

const MIN_CHARS = 16

export async function runMessageEmbedding({ limit = 500, batch = 16 } = {}): Promise<{ embedded: number, failed: number, remaining: number }> {
  const db = useDb()
  // message content is immutable, so the gate is just: embedding IS NULL AND content long enough
  const needWhere = and(isNull(messages.embedding), sql`length(coalesce(${messages.content}, '')) >= ${MIN_CHARS}`)
  const rows = await db.select({ id: messages.id, content: messages.content }).from(messages).where(needWhere).limit(limit)
  let embedded = 0, failed = 0
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    const texts = slice.map(r => r.content.slice(0, 8000))
    let vectors: number[][] | null = null
    try { vectors = await embed(texts) } catch { vectors = null }
    if (vectors) {
      for (let j = 0; j < slice.length; j++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.update(messages).set({ embedding: vectors[j] as any }).where(eq(messages.id, slice[j]!.id))
        embedded++
      }
    } else {
      // per-message fallback: isolate any poison row
      for (let j = 0; j < slice.length; j++) {
        try {
          const [v] = await embed([texts[j]!])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await db.update(messages).set({ embedding: v as any }).where(eq(messages.id, slice[j]!.id))
          embedded++
        } catch {
          console.warn(`[message-embedding] skipping poison message ${slice[j]!.id} — will retry next run`)
          failed++
        }
      }
    }
  }
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(messages).where(needWhere)
  const count = countRows[0]!.count
  return { embedded, failed, remaining: Number(count) }
}
