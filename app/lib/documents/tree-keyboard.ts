/**
 * Pure decision logic for the documents tree's keyboard layer.
 *
 * Extracted from Tree.vue for the same reason `tree-drag.ts` extracted the drop rules: `UTree`
 * (reka-ui's `TreeRoot`) used to provide roving tabindex, arrow-key movement and typeahead for
 * free, and Task 13 replaced it with a hand-rolled recursive renderer that cannot host
 * `useSortable`. Losing `UTree` meant losing all of that along with it — this module is what's
 * left of it once every decision that can be expressed as a function of paths/labels/booleans
 * is pulled out of the component and made unit-testable without a DOM or a live keypress.
 *
 * What stays in Tree.vue: anything that has to read or write live component state
 * (`childrenByPath`, `expandedKeys`, DOM focus via `rowRefs`) — the orchestration, not the
 * decisions.
 */

export type VerticalDirection = 'up' | 'down'

/** Up/Down: the neighbour of `current` in `paths`, or `null` at either end. */
export function nextVisiblePath(paths: string[], current: string, direction: VerticalDirection): string | null {
  const i = paths.indexOf(current)
  if (i === -1) return null
  const j = direction === 'down' ? i + 1 : i - 1
  return j >= 0 && j < paths.length ? paths[j]! : null
}

export type ArrowAction =
  | { type: 'collapse' | 'expand' | 'noop' }
  | { type: 'moveTo', path: string }

/**
 * Left: an expanded folder collapses in place; anything else (a collapsed folder, or a file)
 * hands focus up to its parent folder's row — unless the parent IS the root, which has no row
 * of its own to land on.
 */
export function arrowLeftAction(
  item: { nodeType: 'file' | 'folder', expanded: boolean },
  parentPath: string
): ArrowAction {
  if (item.nodeType === 'folder' && item.expanded) return { type: 'collapse' }
  return parentPath === '/' ? { type: 'noop' } : { type: 'moveTo', path: parentPath }
}

/**
 * Right: a collapsed folder expands in place; an already-expanded folder hands focus to its
 * first child. A file (or an expanded folder with no children) is a no-op.
 */
export function arrowRightAction(
  item: { nodeType: 'file' | 'folder', expanded: boolean },
  firstChildPath: string | null
): ArrowAction {
  if (item.nodeType !== 'folder') return { type: 'noop' }
  if (!item.expanded) return { type: 'expand' }
  return firstChildPath ? { type: 'moveTo', path: firstChildPath } : { type: 'noop' }
}

/**
 * Typeahead: the next path (starting one past `current`, wrapping around the whole list) whose
 * label starts with `buffer`, case-insensitive. `null` when nothing matches, `buffer` is empty,
 * or `current` isn't even in `paths` (can happen for a stale/vanished focus target).
 */
export function typeaheadMatch(
  paths: string[],
  labelOf: (path: string) => string | undefined,
  current: string,
  buffer: string
): string | null {
  const start = paths.indexOf(current)
  if (start === -1 || paths.length === 0 || !buffer) return null
  const needle = buffer.toLowerCase()
  for (let step = 1; step <= paths.length; step++) {
    const path = paths[(start + step) % paths.length]!
    const label = labelOf(path)
    if (label && label.toLowerCase().startsWith(needle)) return path
  }
  return null
}

/**
 * A path guaranteed to survive deleting `itemPath` — the previous sibling, else the next
 * sibling, else the parent folder (unless that's the root, which has no row of its own).
 *
 * Computed BEFORE a delete is attempted: siblings can never be descendants of `itemPath`, so
 * this stays correct whether `itemPath` is a file or an expanded folder with children — but by
 * the time the delete actually SUCCEEDS, `itemPath` (and everything under it) is already gone
 * from the tree, so there is nothing left to compute a sibling from at that point.
 */
export function neighborPathFor(itemPath: string, siblingPaths: string[], parentPath: string): string | null {
  const idx = siblingPaths.indexOf(itemPath)
  if (idx > 0) return siblingPaths[idx - 1]!
  if (idx !== -1 && idx < siblingPaths.length - 1) return siblingPaths[idx + 1]!
  return parentPath === '/' ? null : parentPath
}

/** All ancestor folder paths of `path`, root-first, `path` itself last — e.g.
 *  `"/a/b"` → `["/a", "/a/b"]`. Used by a breadcrumb-segment click to expand every folder on
 *  the way down to the one that was clicked. */
export function folderChainOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    out.push(acc)
  }
  return out
}
