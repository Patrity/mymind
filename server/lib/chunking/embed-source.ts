import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { chunks } from '../../db/schema'
import { embed } from '../ai/embeddings'
import { chunkMarkdown } from './chunk-markdown'
import { contextualizeChunk } from './contextualize'
import { getChunkingConfig } from './config'

/**
 * Chunk a source's text, contextualize + embed each chunk, and replace the source's
 * chunk rows transactionally. Returns the number of chunks written.
 */
export async function chunkAndEmbedSource(opts: {
  sourceType: 'document' | 'image'
  sourceId: string
  title: string | null
  body: string
}): Promise<number> {
  const db = useDb()
  const cfg = await getChunkingConfig()
  const full = `${opts.title ?? ''}\n\n${opts.body}`.trim()
  const parts = chunkMarkdown(full, {
    title: opts.title, targetTokens: cfg.targetTokens, maxTokens: cfg.maxTokens, overlapTokens: cfg.overlapTokens
  })

  if (parts.length === 0) {
    await db.delete(chunks).where(and(eq(chunks.sourceType, opts.sourceType), eq(chunks.sourceId, opts.sourceId)))
    return 0
  }

  // Contextualize sequentially (keeps the doc prefix warm for prefix-caching servers).
  const contexts: string[] = []
  for (const p of parts) {
    contexts.push(await contextualizeChunk({ doc: full, chunk: p.content, headingPath: p.headingPath, enabled: cfg.contextual }))
  }

  // Embed prefixed texts in sub-batches.
  const embedTexts = parts.map((p, i) => `${contexts[i]}\n\n${p.content}`)
  const vectors: number[][] = []
  for (let i = 0; i < embedTexts.length; i += cfg.embedBatch) {
    const slice = embedTexts.slice(i, i + cfg.embedBatch)
    vectors.push(...await embed(slice))
  }

  const rows = parts.map((p, i) => ({
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    ord: p.ord,
    content: p.content,
    context: cfg.contextual ? contexts[i] : null,
    headingPath: p.headingPath,
    tokenCount: p.tokenCount,
    charStart: p.charStart,
    charEnd: p.charEnd,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedding: vectors[i] as any,
    embeddedTextHash: createHash('sha256').update(embedTexts[i]!).digest('hex')
  }))

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(and(eq(chunks.sourceType, opts.sourceType), eq(chunks.sourceId, opts.sourceId)))
    await tx.insert(chunks).values(rows)
  })
  return rows.length
}
