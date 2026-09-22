export interface PathRow { id: string; parentId: string | null }

/**
 * The active path, root-first. A thread is a tree; what the user is reading (and what the
 * model must be given) is one path through it, named by its leaf.
 *
 * Returns [] rather than a partial path when the leaf is unknown: the caller falls back to
 * the flat read, and a half-path would be worse than an obvious empty.
 */
export function activePath<T extends PathRow>(rows: T[], leafId: string | null): T[] {
  if (!leafId) return []
  const byId = new Map(rows.map(r => [r.id, r]))
  if (!byId.has(leafId)) return []
  const out: T[] = []
  const seen = new Set<string>()
  let cur: string | null = leafId
  // `seen` is the cycle guard: a corrupt parent chain must terminate, not spin.
  while (cur && !seen.has(cur)) {
    const row = byId.get(cur)
    if (!row) break
    seen.add(cur)
    out.push(row)
    cur = row.parentId
  }
  return out.reverse()
}

/** 1-based position among siblings plus the sibling count — what the ‹ n/N › pager renders. */
export function branchIndex(rows: PathRow[]): Map<string, { index: number; total: number }> {
  const byParent = new Map<string, PathRow[]>()
  for (const r of rows) {
    const key = r.parentId ?? '\x00root'
    const list = byParent.get(key)
    if (list) list.push(r)
    else byParent.set(key, [r])
  }
  const out = new Map<string, { index: number; total: number }>()
  for (const siblings of byParent.values()) {
    siblings.forEach((r, i) => out.set(r.id, { index: i + 1, total: siblings.length }))
  }
  return out
}
