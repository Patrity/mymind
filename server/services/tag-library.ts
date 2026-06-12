import { isNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { documents, images } from '../db/schema'

// ---------------------------------------------------------------------------
// Tag splitting utility
// ---------------------------------------------------------------------------

export interface SplitTagsResult {
  confirmed: string[]
  recommended: string[]
}

/**
 * Split AI-suggested tags into confirmed (already in library) and recommended (new).
 * Normalises case and whitespace; deduplicates within the output.
 */
export function splitTags(suggested: string[], library: Set<string>): SplitTagsResult {
  const norm = (t: string) => t.trim().toLowerCase()
  const seen = new Set<string>()
  const confirmed: string[] = []
  const recommended: string[] = []

  for (const raw of suggested) {
    const t = norm(raw)
    if (!t || seen.has(t)) continue
    seen.add(t)
    ;(library.has(t) ? confirmed : recommended).push(t)
  }

  return { confirmed, recommended }
}

// ---------------------------------------------------------------------------
// Tag library builder
// ---------------------------------------------------------------------------

export async function buildTagLibrary(): Promise<Set<string>> {
  const db = useDb()

  // Fetch all distinct tags from live documents
  const docTags = await db
    .selectDistinct({ tag: sql<string>`unnest(${documents.tags})` })
    .from(documents)
    .where(isNull(documents.deletedAt))

  // Fetch all distinct tags from images (no deleted_at filter needed — images use soft delete too)
  const imgTags = await db
    .selectDistinct({ tag: sql<string>`unnest(${images.tags})` })
    .from(images)
    .where(isNull(images.deletedAt))

  const library = new Set<string>()
  for (const { tag } of [...docTags, ...imgTags]) {
    if (tag && tag.trim()) library.add(tag.trim().toLowerCase())
  }
  return library
}
