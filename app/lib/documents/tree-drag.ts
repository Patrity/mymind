/**
 * Pure path maths for tree drag-and-drop.
 *
 * Extracted from Tree.vue so the rules that decide "where does this land" and "is this drop
 * even legal" are unit-testable without a DOM, a Sortable instance or a live drag. Tree.vue
 * keeps the wiring; every decision that can be expressed as a function of paths lives here.
 *
 * There is deliberately no ordering logic: the tree's sort order is automatic (folders first,
 * then alphabetical, applied server-side in `buildTree`) and this cycle adds no `sort_order`
 * column, so a drop only ever changes *containment*, never position.
 */

/** The trailing segment of a path — `/a/b/c.md` → `c.md`, `/a/b` → `b`. */
function baseOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Where `itemPath` ends up when dropped into `folderPath`.
 * `/a/b.md` into `/x` → `/x/b.md`; into the root `/` → `/b.md`.
 */
export function destinationPathFor(itemPath: string, folderPath: string): string {
  const base = baseOf(itemPath)
  return folderPath === '/' ? `/${base}` : `${folderPath}/${base}`
}

/** True when `candidate` IS `ancestor` or sits anywhere underneath it. */
export function isSelfOrDescendant(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true
  const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`
  return candidate.startsWith(prefix)
}

/**
 * Is dropping `item` into `folderPath` legal?
 *
 * A folder can't be dropped into itself or into its own subtree — the server refuses it as
 * `invalid`, and letting Sortable attempt it would try to move a DOM node into its own
 * descendant. Anything else is allowed; a drop back into the folder the item already lives in
 * is legal but is a no-op (see `isNoOpDrop`), not an error.
 */
export function canDropInto(item: { path: string, nodeType: 'file' | 'folder' }, folderPath: string): boolean {
  if (item.nodeType !== 'folder') return true
  return !isSelfOrDescendant(folderPath, item.path)
}

/** True when the item already lives directly in the destination folder — nothing to persist. */
export function isNoOpDrop(itemPath: string, folderPath: string): boolean {
  return destinationPathFor(itemPath, folderPath) === itemPath
}

/**
 * Drop any path that is already covered by a selected *folder* in the same set.
 *
 * A multi-select drag of `/a` together with `/a/b.md` must move the folder once, not move the
 * folder and then chase a child whose path the folder move has already rewritten (that second
 * call would 404 on a path that no longer exists).
 */
export function prunePathsUnderFolders(
  paths: string[],
  nodeTypeOf: (path: string) => 'file' | 'folder' | undefined
): string[] {
  const folders = paths.filter(p => nodeTypeOf(p) === 'folder')
  return paths.filter(p => !folders.some(f => f !== p && isSelfOrDescendant(p, f)))
}

/**
 * The project a path belongs to — `/projects/<slug>/…` → `<slug>`, anything else → `null`.
 *
 * `documents.path` is what decides project membership (see `resolveDocProjectFromPath`), so this
 * is enough to tell a drag that crosses a project boundary from one that doesn't, without a
 * server round-trip. It is a *warning* input only: the authoritative re-association still happens
 * server-side on the move, and a FOLDER move is gated by the real `impact` call instead.
 */
export function projectSlugOfPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 2 && parts[0] === 'projects' ? parts[1]! : null
}
