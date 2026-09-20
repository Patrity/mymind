export interface SessionCursor {
  createdAt: string
  id: string
}

/**
 * The transcript orders by (created_at, id). 26% of prod messages share a created_at with
 * another message in the same session — one tie group holds 615 rows — so a timestamp-only
 * cursor would skip or repeat whole blocks. `id` is an arbitrary but STABLE tiebreak.
 * Base64 keeps it opaque so nothing client-side starts parsing it.
 */
export function encodeCursor(c: SessionCursor): string {
  return btoa(`${c.createdAt}|${c.id}`)
}

export function decodeCursor(raw: string): SessionCursor | null {
  if (!raw) return null
  let decoded: string
  try {
    decoded = atob(raw)
  } catch {
    return null
  }
  const sep = decoded.indexOf('|')
  if (sep <= 0 || sep === decoded.length - 1) return null
  const createdAt = decoded.slice(0, sep)
  const id = decoded.slice(sep + 1)
  if (Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}
