import type { TreeNode } from '~~/server/services/tree'

/**
 * Pure, best-effort transforms of the `['document','list']` tree shape, used ONLY to paint an
 * optimistic guess into the vue-query cache the instant a mutation is fired (Task 15). None of
 * these are the source of truth — `onSettled` always invalidates the query afterwards, and the
 * server's real answer (sort order, colour inheritance cascade, folder ids) wins the moment it
 * lands. Deliberately kept dumb: this does NOT reimplement `buildTree`/`applyFolderColors`
 * (server/services/tree.ts) — it does just enough to make the row LOOK right for the half-second
 * before the network round-trip completes.
 *
 * Untouched by drag-and-drop: Tree.vue's `childrenByPath`/`pendingMoves` machinery (Task 13) is
 * its own optimistic path and never calls into this file.
 */

function baseOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function dirnameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

function cloneTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(n => ({ ...n, children: n.children ? cloneTree(n.children) : n.children }))
}

/** Folders first, then alphabetical — mirrors `buildTree`'s sort in server/services/tree.ts so an
 *  optimistic insert doesn't visibly jump position once the real tree lands. */
function sortSiblings(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1)
}

/** Remove the node living at `path` (file or folder, wherever it is in the tree) and hand it
 *  back so the caller can re-insert it elsewhere. `removed` is `null` when `path` isn't found —
 *  callers treat that as "nothing safe to do" and leave the tree as-is. */
function extractNode(nodes: TreeNode[], path: string): { tree: TreeNode[], removed: TreeNode | null } {
  const out: TreeNode[] = []
  let removed: TreeNode | null = null
  for (const n of nodes) {
    if (removed) { out.push(n); continue }
    if (n.path === path) { removed = n; continue }
    if (n.children) {
      const res = extractNode(n.children, path)
      if (res.removed) { removed = res.removed; out.push({ ...n, children: res.tree }); continue }
    }
    out.push(n)
  }
  return { tree: out, removed }
}

/** Insert `node` as a child of the folder at `parentPath` (`'/'` = the top-level list). No-ops
 *  (drops the node) if `parentPath` names a folder that isn't in the tree — that only happens if
 *  the caller passed a bad path, and silently doing nothing is safer than inserting nowhere
 *  visible or throwing out of an `onMutate`. */
function insertAt(nodes: TreeNode[], parentPath: string, node: TreeNode): TreeNode[] {
  if (parentPath === '/' || parentPath === '') {
    return sortSiblings([...nodes, node])
  }
  return nodes.map((n) => {
    if (n.type === 'folder' && n.path === parentPath) {
      return { ...n, children: sortSiblings([...(n.children ?? []), node]) }
    }
    if (n.children) return { ...n, children: insertAt(n.children, parentPath, node) }
    return n
  })
}

/** Rewrite a node's own path/name to `newPath`, and — for a folder — every descendant's path
 *  prefix along with it (a folder rename/move carries its whole subtree). */
function rewritePath(node: TreeNode, oldPath: string, newPath: string): TreeNode {
  const newName = baseOf(newPath)
  if (node.type === 'file' || !node.children) {
    return { ...node, path: newPath, name: newName }
  }
  const rewriteChildren = (children: TreeNode[], oldPrefix: string, newPrefix: string): TreeNode[] =>
    children.map((c) => {
      const childNewPath = newPrefix + c.path.slice(oldPrefix.length)
      return c.children
        ? { ...c, path: childNewPath, children: rewriteChildren(c.children, c.path, childNewPath) }
        : { ...c, path: childNewPath }
    })
  return { ...node, path: newPath, name: newName, children: rewriteChildren(node.children, oldPath, newPath) }
}

/**
 * A rename is a move within the same parent — same operation either way (mirrors the server-side
 * comment on `moveFolder`/RenameModal: "a rename is a move within the same parent"). Handles both
 * files and folders (folder moves carry their subtree via `rewritePath`).
 */
export function moveNodeInTree(tree: TreeNode[], oldPath: string, newPath: string): TreeNode[] {
  if (oldPath === newPath) return tree
  const { tree: withoutNode, removed } = extractNode(cloneTree(tree), oldPath)
  if (!removed) return tree
  return insertAt(withoutNode, dirnameOf(newPath), rewritePath(removed, oldPath, newPath))
}

/** Drop the node at `path` (file or folder, subtree included) from the tree. */
export function removeNodeFromTree(tree: TreeNode[], path: string): TreeNode[] {
  return extractNode(cloneTree(tree), path).tree
}

/**
 * Set a folder's OWN colour override, or clear it back toward inheriting.
 *
 * `TreeNode.color` is documented (server/services/tree.ts) as the colour to render AFTER
 * inheritance — every folder already carries its fully-resolved colour, override or not. That
 * means clearing an override can be guessed correctly without reproducing the server's cascade:
 * the target's nearest ANCESTOR FOLDER's `.color` in the tree we already hold IS what this folder
 * would inherit (that ancestor's own value is itself already fully resolved, however it got
 * there), so walking up to it is enough — no need to re-derive anything.
 *
 * What this can't see: `projects.color`. If `folderId` IS a project root (e.g. `/projects/foo`)
 * with no coloured ancestor FOLDER above it, clearing its override server-side reveals the
 * PROJECT's colour — but that colour isn't present anywhere in the cached tree while the
 * override is active (only one of own/project/inherited is ever resolved into `.color` at a
 * time), so this one case still optimistically blanks to null/null. `onSettled`'s invalidate
 * corrects it a moment later, the same trade-off already made for descendants below.
 *
 * Deliberately does not touch DESCENDANTS: a folder inheriting colour from the one just
 * recoloured/cleared shows its old colour for one settle cycle, which the same invalidate fixes.
 * Reproducing that cascade too would mean re-implementing `applyFolderColors` — exactly the
 * "duplicated server logic that could get it wrong" this file's top comment warns against.
 */
export function setFolderColorInTree(tree: TreeNode[], folderId: string, color: string | null): TreeNode[] {
  const walk = (nodes: TreeNode[], ancestorColor: string | null): TreeNode[] => nodes.map((n) => {
    if (n.type !== 'folder') return n
    if (n.id === folderId) {
      if (color) return { ...n, color, colorSource: 'own' }
      return ancestorColor
        ? { ...n, color: ancestorColor, colorSource: 'inherited' }
        : { ...n, color: null, colorSource: null }
    }
    // `n.color` is already fully resolved (own, project, or inherited) — that's exactly what a
    // child of `n` would itself inherit, so it's all the next level down needs to know.
    return n.children ? { ...n, children: walk(n.children, n.color ?? null) } : n
  })
  return walk(cloneTree(tree), null)
}

/** Insert a new file node at `path` under a temporary id, standing in until the real DTO settles. */
export function insertDocumentInTree(tree: TreeNode[], tempId: string, path: string): TreeNode[] {
  const node: TreeNode = { id: tempId, name: baseOf(path), path, type: 'file', title: null }
  return insertAt(cloneTree(tree), dirnameOf(path), node)
}

/** Insert a new, empty folder node at `path` under a temporary id. */
export function insertFolderInTree(tree: TreeNode[], tempId: string, path: string): TreeNode[] {
  const node: TreeNode = { id: tempId, name: baseOf(path), path, type: 'folder', children: [], color: null, colorSource: null }
  return insertAt(cloneTree(tree), dirnameOf(path), node)
}
