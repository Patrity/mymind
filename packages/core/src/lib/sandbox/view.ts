// Cycle 82 Task 3 (spec §7): what the Files and Shells UI reads from a workspace — run in the WORKER
// (it owns the sandbox; the web asks over the `workspace-view` / `workspace-kill-shell` commands).
//
// Path safety (spec §2): nothing is resolved on the host. A UI path must be RELATIVE, without `..`
// or NUL (checked in the web route, again in the worker, and a third time inside the container,
// where the path is resolved with realpath and refused when it lands outside /workspace — a symlink
// to /etc/passwd shows as a link in the tree and cannot be opened or downloaded). The scripts are
// fixed text; the path travels as JSON on stdin.
//
// Limits: the tree lists ≤ 500 entries; a file view returns ≤ 2000 lines / 1 MB (flagged
// `truncated`); a download streams in chunks (the web stops at 100 MB with 413). Secret values are
// masked in views and shell output (sandbox/secrets.ts); a download is the raw file.
import { META_DIR, shq } from './fs-ops'
import { CHUNK_BYTES, DOWNLOAD_MAX_BYTES, workspacePathProblem } from './paths'
export { CHUNK_BYTES, DOWNLOAD_MAX_BYTES, workspacePathProblem }
import { maskCut, maskSecretValues, secretValues } from './secrets'
import type { SandboxExecResult } from './manager'
import { workspaceRuntime } from './runtime'
import type { WorkspaceFileView, WorkspaceShellTail, WorkspaceTree, WorkspaceTreeEntry } from '../../shared/types/workspaces'

export const TREE_MAX_ENTRIES = 500
export const VIEW_MAX_LINES = 2000
export const VIEW_MAX_BYTES = 1_000_000

export class WorkspaceViewError extends Error {
  override name = 'WorkspaceViewError'
  constructor(message: string, readonly code: 'bad_path' | 'not_found' | 'not_a_file' | 'outside' | 'changed' | 'failed' = 'failed') { super(message) }
}

// `-I` (fix round 1, M3): isolated mode — the cwd (/workspace) is NOT put on sys.path and user
// site/PYTHON* env are ignored, so a workspace file named json.py / base64.py (or a usercustomize
// under the writable /home/agent) can't run inside a UI read and forge its answer or the path check.
const py = (lines: string[]) => `python3 -I -c ${shq(lines.join('\n'))}`

// Shared: read {..} from stdin, resolve a path INSIDE the container and refuse what leaves /workspace.
const PRELUDE = [
  'import sys, os, json, stat',
  'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
  'a = json.load(sys.stdin)',
  'def out(o):',
  '    sys.stdout.write(json.dumps(o, ensure_ascii=False)); sys.exit(0)',
  'root = os.path.realpath(os.getcwd())',
  'def resolve(p):',
  '    if not isinstance(p, str) or not p or p.startswith("/") or "\\0" in p or ".." in p.replace("\\\\", "/").split("/"):',
  '        out({"error": "bad_path", "message": "the path must be relative to the workspace, without .."})',
  '    full = os.path.realpath(os.path.join(root, p))',
  '    if full != root and not full.startswith(root + os.sep): out({"error": "outside", "message": "the path leads outside the workspace"})',
  '    return full',
  'def regular(p):',
  '    full = resolve(p)',
  '    try: st = os.stat(full)',
  '    except FileNotFoundError: out({"error": "not_found", "message": "no such file"})',
  '    except PermissionError: out({"error": "not_a_file", "message": "permission denied"})',
  '    if not stat.S_ISREG(st.st_mode): out({"error": "not_a_file", "message": "not a regular file"})',
  '    return full, st'
]

const NOISE = ['.git', META_DIR, 'node_modules', '__pycache__', '.venv', '.mypy_cache', '.pytest_cache']

/** Flat listing (dirs first per level, sorted), ≤ TREE_MAX_ENTRIES. Noise dirs are listed but not
 *  entered (`skipped`); symlinks are listed as links and never followed. */
export const TREE_SCRIPT = py([
  ...PRELUDE,
  `cap = ${TREE_MAX_ENTRIES}; noise = set(${JSON.stringify(NOISE)})`,
  'res = []; more = False',
  'def walk(d, rel):',
  '    global more',
  '    try: names = sorted(os.listdir(d))',
  '    except OSError: return',
  '    ents = []',
  '    for n in names:',
  '        fp = os.path.join(d, n)',
  '        try: st = os.lstat(fp)',
  '        except OSError: continue',
  '        ents.append((0 if stat.S_ISDIR(st.st_mode) else 1, n, fp, st))',
  '    ents.sort(key=lambda e: (e[0], e[1].lower()))',
  '    for kind, n, fp, st in ents:',
  '        if len(res) >= cap: more = True; return',
  '        r = n if not rel else rel + "/" + n',
  '        if stat.S_ISLNK(st.st_mode):',
  '            try: t = os.readlink(fp)',
  '            except OSError: t = ""',
  '            res.append({"path": r, "type": "link", "bytes": st.st_size, "target": t[:300]})',
  '        elif stat.S_ISDIR(st.st_mode):',
  '            skip = n in noise',
  '            res.append({"path": r, "type": "dir", "bytes": None, **({"skipped": True} if skip else {})})',
  '            if not skip: walk(fp, r)',
  '            if more: return',
  '        elif stat.S_ISREG(st.st_mode):',
  '            res.append({"path": r, "type": "file", "bytes": st.st_size, "mtime": int(st.st_mtime)})',
  'walk(root, "")',
  'out({"entries": res, "count": len(res), "truncated": more})'
])

/** A text view: a JSON header line, then the (UTF-8) text itself — ≤ VIEW_MAX_LINES lines and
 *  VIEW_MAX_BYTES bytes, `truncated` when the file has more. Binary files return only the header. */
export const VIEW_SCRIPT = py([
  ...PRELUDE,
  `maxl = ${VIEW_MAX_LINES}; maxb = ${VIEW_MAX_BYTES}`,
  'full, st = regular(a["path"])',
  'with open(full, "rb") as f: raw = f.read(maxb + 1)',
  'if b"\\0" in raw[:8192]:',
  '    sys.stdout.write(json.dumps({"binary": True, "bytes": st.st_size}) + "\\n"); sys.exit(0)',
  'truncated = len(raw) > maxb or st.st_size > maxb',
  'raw = raw[:maxb]',
  'lines = raw.split(b"\\n")',
  'if len(lines) > maxl + (1 if raw.endswith(b"\\n") else 0): lines = lines[:maxl]; truncated = True; raw = b"\\n".join(lines) + b"\\n"',
  'text = raw.decode("utf-8", "replace")',
  'enc = text.encode("utf-8")',
  'if len(enc) > maxb: text = enc[:maxb].decode("utf-8", "ignore"); truncated = True',
  'n = text.count("\\n") + (0 if text.endswith("\\n") or not text else 1)',
  'sys.stdout.write(json.dumps({"binary": False, "bytes": st.st_size, "lines": n, "truncated": truncated}) + "\\n")',
  'sys.stdout.write(text)'
])

/** One download chunk: a JSON header line ({size, mtimeNs}), then base64 of bytes [offset, offset+length). */
export const CHUNK_SCRIPT = py([
  ...PRELUDE,
  'import base64',
  'full, st = regular(a["path"])',
  `off = max(0, int(a.get("offset") or 0)); ln = max(0, min(int(a.get("length") or 0), ${CHUNK_BYTES}))`,
  'data = b""',
  'if ln:',
  '    with open(full, "rb") as f: f.seek(off); data = f.read(ln)',
  'sys.stdout.write(json.dumps({"size": st.st_size, "mtimeNs": st.st_mtime_ns}) + "\\n")',
  'sys.stdout.write(base64.b64encode(data).decode("ascii"))'
])

function headerAndBody(r: SandboxExecResult, what: string): { head: Record<string, unknown>; body: string } {
  const nl = r.stdout.indexOf('\n')
  const first = nl < 0 ? r.stdout : r.stdout.slice(0, nl)
  let head: Record<string, unknown> | null = null
  try { head = r.exitCode === 0 ? JSON.parse(first) as Record<string, unknown> : null } catch { head = null }
  if (!head) throw new WorkspaceViewError(`could not ${what}: ${r.timedOut ? 'timed out' : r.truncated ? 'the output was too large' : (r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`)}`)
  if (typeof head.error === 'string') {
    const code = (['bad_path', 'not_found', 'not_a_file', 'outside'] as const).find(c => c === head!.error) ?? 'failed'
    throw new WorkspaceViewError(String(head.message ?? head.error), code)
  }
  return { head, body: nl < 0 ? '' : r.stdout.slice(nl + 1) }
}

function checkPath(p: string): void {
  const why = workspacePathProblem(p)
  if (why) throw new WorkspaceViewError(why, 'bad_path')
}

const exec = (id: string, script: string, o: { input?: string; capBytes?: number; timeoutSec?: number } = {}) =>
  workspaceRuntime().manager.exec(id, script, { timeoutSec: 60, ...o })

export async function viewTree(workspaceId: string): Promise<WorkspaceTree> {
  const r = await exec(workspaceId, TREE_SCRIPT, { input: '{}', capBytes: 512 * 1024, timeoutSec: 60 })
  let j: { entries?: WorkspaceTreeEntry[]; count?: number; truncated?: boolean; error?: string } | null = null
  try { j = r.exitCode === 0 ? JSON.parse(r.stdout) : null } catch { j = null }
  if (!j?.entries) throw new WorkspaceViewError(`could not list the workspace: ${r.timedOut ? 'timed out' : (r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`)}`)
  return maskSecretValues({ entries: j.entries, count: j.count ?? j.entries.length, truncated: !!j.truncated })
}

export async function viewFile(workspaceId: string, path: string): Promise<WorkspaceFileView> {
  checkPath(path)
  const r = await exec(workspaceId, VIEW_SCRIPT, { input: JSON.stringify({ path }), capBytes: 1024 * 1024 })
  const { head, body } = headerAndBody(r, `read ${path}`)
  if (head.binary) return { path, binary: true, bytes: Number(head.bytes) }
  const truncated = !!head.truncated || r.truncated
  // M1: masked whole, then — when the view stopped before the end of the file — the cut edge is
  // trimmed of anything that could be the first half of a value.
  return { path, binary: false, bytes: Number(head.bytes), lines: Number(head.lines), truncated, content: maskCut(body, await secretValues(), { end: truncated }) }
}

export interface FileChunk { size: number; mtimeNs: string; data: string }

/** `length` 0 = just the size (the web's 413 check). `data` is base64. */
export async function readChunk(workspaceId: string, path: string, offset: number, length: number): Promise<FileChunk> {
  checkPath(path)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > CHUNK_BYTES) throw new WorkspaceViewError('bad chunk range', 'bad_path')
  const r = await exec(workspaceId, CHUNK_SCRIPT, { input: JSON.stringify({ path, offset, length }), capBytes: 1024 * 1024 })
  if (r.truncated) throw new WorkspaceViewError('the chunk was larger than the output cap')
  const { head, body } = headerAndBody(r, `read ${path}`)
  return { size: Number(head.size), mtimeNs: String(head.mtimeNs), data: body.trim() }
}

export async function shellTail(workspaceId: string, shellId: string): Promise<WorkspaceShellTail> {
  // The registry masks the tail itself (before trimming its cut edges).
  return workspaceRuntime().shells.tail(workspaceId, shellId)
}

export async function killShellFromUi(workspaceId: string, shellId: string) {
  const k = await workspaceRuntime().shells.kill(workspaceId, shellId, { reason: 'stopped by Tony (Shells tab)' })
  return { shellId: k.shellId, state: k.state, alreadyEnded: k.alreadyEnded }
}
