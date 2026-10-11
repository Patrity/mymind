// Cycle 82 Task 3: pure helpers for the Files / Shells UI (unit-tested).
import type { WorkspaceTreeEntry } from '@mymind/core/shared/types/workspaces'

export interface FileNode {
  label: string
  path: string
  type: WorkspaceTreeEntry['type']
  bytes: number | null
  skipped?: boolean
  target?: string
  children?: FileNode[]
}

/** Flat listing (parents before children) → nested nodes; a directory's `bytes` = the sum of the
 *  files listed under it (what the tree shows — skipped dirs are not entered, so they show none). */
export function buildTree(entries: WorkspaceTreeEntry[]): FileNode[] {
  const roots: FileNode[] = []
  const dirs = new Map<string, FileNode>()
  for (const e of entries) {
    const parts = e.path.split('/')
    const label = parts.pop() || e.path
    const node: FileNode = { label, path: e.path, type: e.type, bytes: e.bytes, ...(e.skipped ? { skipped: true } : {}), ...(e.target !== undefined ? { target: e.target } : {}) }
    if (e.type === 'dir') { node.children = []; dirs.set(e.path, node) }
    const parent = dirs.get(parts.join('/'))
    if (parts.length && parent) parent.children!.push(node)
    else roots.push(node)
  }
  const total = (n: FileNode): number => {
    if (n.type !== 'dir') return n.bytes ?? 0
    const sum = (n.children ?? []).reduce((a, c) => a + total(c), 0)
    n.bytes = n.skipped ? null : sum
    return sum
  }
  roots.forEach(total)
  return roots
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const CODE_LANGS: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', vue: 'vue', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', css: 'css', scss: 'scss', html: 'html', go: 'go', rs: 'rust',
  rb: 'ruby', java: 'java', c: 'c', h: 'c', cpp: 'cpp', dockerfile: 'dockerfile', xml: 'xml', ini: 'ini', diff: 'diff'
}

/** How a text file is shown: markdown and code through the hardened renderer, anything else plain. */
export function viewKind(path: string): { kind: 'markdown' } | { kind: 'code'; lang: string } | { kind: 'text' } {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return { kind: 'code', lang: 'dockerfile' }
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown' }
  const lang = CODE_LANGS[ext]
  return lang ? { kind: 'code', lang } : { kind: 'text' }
}

/** A fenced block the content can't break out of (the fence is longer than any backtick run in it). */
export function fenced(content: string, lang: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map(s => s.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`
}
