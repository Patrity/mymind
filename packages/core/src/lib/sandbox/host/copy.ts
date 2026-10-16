// Cycle 86: export_to_coordinator's copy on the host — a child's files into its coordinator's
// workspace under `from/<childId>/`. Both are directories on the same Mac, so the worker copies them
// itself (cycle 83 piped a tar through two containers). Only regular files and directories are copied
// — symlinks and special files are skipped (and reported), so a link in the child's workspace can't
// pull a file from elsewhere on the machine into the coordinator's. Every source must stay inside the
// child's dir once its parents are resolved, the destination inside the coordinator's; the whole
// export is sized BEFORE anything is written (bytes + entries), so an over-limit export writes nothing.
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export class CopyError extends Error { override name = 'WorkspaceFileError' }

export interface CopyPlan {
  /** Relative to the source dir. */
  rel: string
  kind: 'file' | 'dir'
  bytes: number
}

function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}${path.sep}`)
}

/** Walk the named paths (relative, no `..`) under `srcDir`; refuse what escapes it. */
export async function planCopy(srcDir: string, paths: string[], limits: { maxBytes: number; maxEntries: number }): Promise<{ plan: CopyPlan[]; bytes: number; skipped: string[] }> {
  const root = await realpath(srcDir)
  const plan: CopyPlan[] = []
  const skipped: string[] = []
  let bytes = 0
  const add = (e: CopyPlan) => {
    plan.push(e)
    bytes += e.bytes
    if (plan.length > limits.maxEntries) throw new CopyError(`more than ${limits.maxEntries} files and directories — export fewer`)
    if (bytes > limits.maxBytes) throw new CopyError(`more than ${limits.maxBytes} bytes — export less`)
  }
  async function walk(rel: string): Promise<void> {
    const full = path.join(root, rel)
    let st
    try { st = await lstat(full) } catch { throw new CopyError(`${rel}: no such file or directory`) }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) { skipped.push(rel); return }
    if (st.isFile()) { add({ rel, kind: 'file', bytes: st.size }); return }
    add({ rel, kind: 'dir', bytes: 0 })
    for (const name of (await readdir(full)).sort()) await walk(path.join(rel, name))
  }
  for (const p of paths) {
    const rel = path.normalize(p).replace(/\/+$/, '')
    if (!rel || rel === '.' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) throw new CopyError(`${p}: must be a path inside your workspace`)
    // A symlinked parent must not lead out of the workspace.
    const parent = await realpath(path.dirname(path.join(root, rel))).catch(() => null)
    if (!parent || !inside(parent, root)) throw new CopyError(`${p}: outside your workspace`)
    await walk(rel)
  }
  return { plan, bytes, skipped }
}

/** mkdir -p below `root`, one segment at a time — an existing segment that is a symlink (or not a
 *  directory) is refused, so a planted link can never redirect the copy out of the workspace. */
async function safeMkdir(root: string, rel: string): Promise<string> {
  let cur = root
  for (const seg of rel.split(path.sep).filter(x => x && x !== '.')) {
    cur = path.join(cur, seg)
    const st = await lstat(cur).catch(() => null)
    if (!st) { await mkdir(cur); continue }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new CopyError(`${path.relative(root, cur)}: the destination is not a directory`)
  }
  return cur
}

/** Copy a plan into `destDir/destRel` (created; never through a symlink). */
export async function applyCopy(srcDir: string, plan: CopyPlan[], destDir: string, destRel: string): Promise<void> {
  const root = await realpath(srcDir)
  const destRoot = await realpath(destDir)
  const target = await safeMkdir(destRoot, destRel)
  for (const e of plan) {
    if (e.kind === 'dir') { await safeMkdir(target, e.rel); continue }
    await safeMkdir(target, path.dirname(e.rel))
    const to = path.join(target, e.rel)
    const existing = await lstat(to).catch(() => null)
    if (existing && !existing.isFile()) throw new CopyError(`${e.rel}: the destination is not a regular file`)
    await copyFile(path.join(root, e.rel), to)
  }
}
