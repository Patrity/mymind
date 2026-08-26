import type { FolderColorSource } from '../../shared/types/folders'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  /** The row's own identifier: a document id for files, the `folders` registry id for
   *  folders (present once `ensureFolders`/`createFolder` has materialized that path).
   *  The colour picker needs this to call `PATCH /api/folders/[id]` — a folder's tree-item
   *  key is its PATH (see Tree.vue), which is not a valid id for that route. */
  id?: string
  title?: string | null
  children?: TreeNode[]
  /** Folders only: the colour to render, after inheritance. */
  color?: string | null
  /** Folders only: where that colour came from, for the picker's hint. */
  colorSource?: FolderColorSource | null
}

interface DocLite { id: string, path: string, title?: string | null }
interface FolderLite { path: string, id?: string }

/**
 * Build the document tree from document paths, unioned with the folder registry.
 *
 * The registry is what makes an empty folder survive: a folder with no documents left has
 * no path to derive it from, so without `folderRows` it would simply disappear from the
 * tree — which is exactly the bug the folders table exists to fix.
 */
export function buildTree(docs: DocLite[], folderRows: FolderLite[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [] }

  /** Walk to a folder path, creating any missing folder nodes on the way. */
  const folderAt = (parts: string[]): TreeNode => {
    let cur = root
    parts.forEach((part, i) => {
      const path = '/' + parts.slice(0, i + 1).join('/')
      let next = cur.children!.find(c => c.name === part && c.type === 'folder')
      if (!next) {
        next = { name: part, path, type: 'folder', children: [] }
        cur.children!.push(next)
      }
      cur = next
    })
    return cur
  }

  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean)
    const name = parts.pop()!
    const parent = folderAt(parts)
    if (!parent.children!.some(c => c.type === 'file' && c.path === doc.path)) {
      parent.children!.push({ name, path: doc.path, type: 'file', id: doc.id, title: doc.title })
    }
  }

  // Registry rows second: any folder a document already implied is found, not duplicated.
  // Every registry row also carries the folder's real id, so this is where a doc-derived
  // stub node (created above with no id) picks one up.
  for (const f of folderRows) {
    const node = folderAt(f.path.split('/').filter(Boolean))
    if (f.id) node.id = f.id
  }

  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
      .map(n => (n.children ? { ...n, children: sort(n.children) } : n))
  return sort(root.children!)
}

/** '/projects/mymind/wiki' → 'mymind'; anything not exactly two levels under /projects → null. */
function projectSlugOfFolder(path: string): string | null {
  const parts = path.split('/').filter(Boolean)
  return parts.length === 2 && parts[0] === 'projects' ? parts[1]! : null
}

/**
 * Resolve each folder's rendered colour, top-down.
 *
 * Precedence: the folder's own colour, else the owning project's colour when the folder IS
 * the project root, else whatever cascaded from an ancestor, else nothing. An override
 * cascades in turn, so a colour set deep in a tree colours everything below it.
 *
 * Pure, and resolved on the server so the client never has to know the precedence rules.
 */
export function applyFolderColors(
  nodes: TreeNode[],
  opts: { own: Map<string, string | null>, projects: Map<string, string> },
  inherited: string | null = null
): TreeNode[] {
  return nodes.map((n) => {
    if (n.type !== 'folder') return n

    const ownColor = opts.own.get(n.path) ?? null
    const slug = projectSlugOfFolder(n.path)
    const projectColor = slug ? opts.projects.get(slug) ?? null : null

    let color: string | null = null
    let colorSource: FolderColorSource | null = null
    if (ownColor) { color = ownColor; colorSource = 'own' }
    else if (projectColor) { color = projectColor; colorSource = 'project' }
    else if (inherited) { color = inherited; colorSource = 'inherited' }

    return {
      ...n,
      color,
      colorSource,
      children: n.children ? applyFolderColors(n.children, opts, color) : n.children
    }
  })
}
