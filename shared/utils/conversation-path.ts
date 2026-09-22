export interface PathRow { id: string; parentId: string | null }

/** A row plus its creation time — what `branchTip` needs to pick the newest child. */
export interface DescendantRow extends PathRow { createdAt: string | number | Date }

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

/**
 * From `fromId`, walk down to the tip of the branch. THE RULE, stated outright because the
 * obvious name for this ("deepest descendant") would be a lie: at each step it follows the
 * NEWEST child, not the child that leads to the deepest subtree — those disagree whenever a
 * shallower child has itself been extended more recently than a deeper one. "Newest child at
 * each step" is deliberate: resuming a branch should land where the user last left off writing
 * it, not down its longest arm. Ordered by `(created_at, id)` (same tie-break as
 * `loadActivePath`), so a branch-within-a-branch resolves deterministically to the tip most
 * recently extended.
 *
 * Switching branches re-points the thread at a SIBLING, not at the sibling's continuation: the
 * client only ever fetches the active path, so it has no way to know an inactive sibling has
 * descendants at all. Landing the leaf on the sibling itself would make everything below it
 * invisible to both read paths (activePath walks UP from the leaf) — silent-hiding is exactly
 * the failure this cycle exists to prevent. Returns `fromId` itself when it has no children, and
 * null when `fromId` is not in `rows` — no guessing, same contract as `activePath`.
 */
export function branchTip<T extends DescendantRow>(rows: T[], fromId: string): string | null {
  const ids = new Set(rows.map(r => r.id))
  if (!ids.has(fromId)) return null

  const byParent = new Map<string, T[]>()
  for (const r of rows) {
    if (r.parentId == null) continue
    const siblings = byParent.get(r.parentId)
    if (siblings) siblings.push(r)
    else byParent.set(r.parentId, [r])
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => {
      const at = new Date(a.createdAt).getTime()
      const bt = new Date(b.createdAt).getTime()
      return at !== bt ? at - bt : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })
  }

  let cur = fromId
  const seen = new Set<string>()
  // `seen` is the cycle guard, mirroring activePath's: a corrupt tree must terminate, not spin.
  while (!seen.has(cur)) {
    seen.add(cur)
    const children = byParent.get(cur)
    if (!children?.length) return cur
    cur = children[children.length - 1]!.id // ascending sort → newest is last
  }
  return cur
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
