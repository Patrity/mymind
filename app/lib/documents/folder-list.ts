import type { TreeNode } from '~~/server/services/tree'

/**
 * Every folder path in the tree, as options for a picker. Root first — creating at the
 * top level has to be reachable, and it is not a node in the tree.
 *
 * Extracted from Tree.vue's private `collectFolders` so the New-document modal and the
 * Move modal read the same list from the same source instead of one of them making the
 * user type a path by hand.
 */
export function collectFolderPaths(nodes: TreeNode[]): string[] {
  const out: string[] = ['/']
  const seen = new Set(out)
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type !== 'folder') continue
      const path = n.path || '/'
      if (!seen.has(path)) { seen.add(path); out.push(path) }
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * The containing folder of a path — `/a/b/c.md` → `/a/b`, `/c.md` → `/`. Shared so
 * documents.vue's "preselect the open document's folder" and Tree.vue's rename/move
 * "default to the current folder" logic can't drift apart the way `collectFolderPaths`
 * was extracted to stop happening to the folder list itself.
 */
export function dirnameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}
