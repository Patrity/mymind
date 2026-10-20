// The lexical lane (2026-10-19 stack review, R3 §4/§6, 03 §2 weakness #3).
//
// Before: every "hybrid" surface's lexical lane was `ILIKE '%q%'` ordered by pg_trgm
// `similarity()`. A substring match on the WHOLE query almost never fires for a multi-word
// natural-language query, so hybrid search was vector-only in practice. After: each surface has a
// stored, generated `tsv` column (migration 0090) and the lane is
// `tsv @@ websearch_to_tsquery('english', q)` ordered by `ts_rank_cd`. The ILIKE lane is kept as
// the FALLBACK for queries FTS handles badly — identifiers, paths, hashes, dotted/colon tokens
// (the english parser splits or stems them) — and for any query the tsquery matches nothing on.
import { sql, type SQL } from 'drizzle-orm'

export type LexicalMode = 'fts' | 'ilike'

const IDENT_CHARS = /[/:_.]/
// ≥7 chars, digits and a-f only, with at least one digit (so "deadbeef" / "cafe" stay words).
const HEXISH = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/i
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i

// Sentence punctuation at the very end ("…deadlock.", "…up?") is not an identifier marker.
const TRAILING_PUNCT = /[.?!,;]+\s*$/

/** Would the english FTS parser mangle this query? Then go straight to the substring lane. */
export function isIdentifierLike(q: string): boolean {
  const s = q.replace(TRAILING_PUNCT, '')
  return IDENT_CHARS.test(s) || UUID.test(s) || HEXISH.test(s)
}

export const tsquery = (q: string): SQL => sql`websearch_to_tsquery('english', ${q})`

/** WHERE fragment: the row's stored tsvector matches the user's query. */
export const ftsMatch = (tsv: SQL, q: string): SQL => sql`${tsv} @@ ${tsquery(q)}`

/** ORDER BY fragment: cover-density rank, best first. */
export const ftsRank = (tsv: SQL, q: string): SQL => sql`ts_rank_cd(${tsv}, ${tsquery(q)}) desc`

export interface LexicalLaneOpts<T> {
  q: string
  /** `SearchRelevanceConfig.lexicalFts` — false = the pre-migration ILIKE lane only. */
  enabled: boolean
  /** Runs the FTS query for this surface. */
  fts: () => Promise<T[]>
  /** Runs the surface's original ILIKE + similarity() query. */
  fallback: () => Promise<T[]>
}

/**
 * Policy for one surface's lexical lane. FTS first for natural-language queries; ILIKE for
 * identifier-like ones, for an empty FTS result, for the kill switch, and if FTS throws (e.g. the
 * `tsv` column is not there yet because the app rolled forward before the migration ran).
 */
export async function runLexicalLane<T>(opts: LexicalLaneOpts<T>): Promise<{ ids: T[], mode: LexicalMode }> {
  if (opts.enabled && !isIdentifierLike(opts.q)) {
    try {
      const ids = await opts.fts()
      if (ids.length) return { ids, mode: 'fts' }
    } catch (err) {
      console.warn('[search] FTS lane failed, falling back to ILIKE:', err)
    }
  }
  return { ids: await opts.fallback(), mode: 'ilike' }
}
