export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  id?: string
  title?: string | null
  children?: TreeNode[]
}

interface DocLite { id: string, path: string, title?: string | null }

export function buildTree(docs: DocLite[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [] }
  for (const doc of docs) {
    const parts = doc.path.split('/').filter(Boolean)
    let cur = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
      const path = '/' + parts.slice(0, i + 1).join('/')
      let next = cur.children!.find(c => c.name === part)
      if (!next) {
        next = isFile
          ? { name: part, path, type: 'file', id: doc.id, title: doc.title }
          : { name: part, path, type: 'folder', children: [] }
        cur.children!.push(next)
      }
      cur = next
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
      .map(n => (n.children ? { ...n, children: sort(n.children) } : n))
  return sort(root.children!)
}
