import { and, isNull, or, sql, eq } from 'drizzle-orm'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { embed } from '../lib/ai/embeddings'

export async function runEmbedding({ limit = 200, batch = 16 } = {}): Promise<{ embedded: number, remaining: number }> {
  const db = useDb()
  // docs needing embedding: live, and (embedding null OR embedded_hash != content_hash)
  const needWhere = and(
    isNull(documents.deletedAt),
    or(isNull(documents.embedding), sql`${documents.embeddedHash} is distinct from ${documents.contentHash}`)
  )
  const rows = await db.select({ id: documents.id, title: documents.title, content: documents.content, contentHash: documents.contentHash })
    .from(documents).where(needWhere).limit(limit)
  let embedded = 0
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    const vectors = await embed(slice.map(r => `${r.title ?? ''}\n\n${r.content}`))
    for (let j = 0; j < slice.length; j++) {
      await db.update(documents)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ embedding: vectors[j] as any, embeddedHash: slice[j]!.contentHash })
        .where(eq(documents.id, slice[j]!.id))
      embedded++
    }
  }
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(documents).where(needWhere)
  const count = countRows[0]!.count
  return { embedded, remaining: Number(count) }
}
