// Cycle 86 Task 6 (spec §4): read a workspace directory (a built dist/) into an artifact bundle.
// Fixed Python scripts run INSIDE the container (paths travel as JSON on stdin, realpath-contained
// under /workspace by the shared PRELUDE); limits are enforced while walking so a huge tree never
// leaves the sandbox; reads go in CHUNK_BYTES batches; text files are secret-masked on the way out.
import { CHUNK_BYTES } from '../sandbox/paths'
import { PRELUDE, py } from '../sandbox/view'
import { workspaceRuntime } from '../sandbox/runtime'
import { maskText, secretValues, SecretStoreUnavailableError } from '../sandbox/secrets'
import { executionMode } from '../agent/runtime/execution-mode'
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_FILE_BYTES, ARTIFACT_MAX_TOTAL_BYTES, ArtifactError, isTextPath } from './limits'

/** Walk `dir`: relative `/`-joined sorted paths + sizes. Dot-dirs / node_modules pruned, symlinks and
 *  non-regular files skipped. Limits are checked as the walk goes. */
export const BUNDLE_LIST_SCRIPT = py([
  ...PRELUDE,
  `maxn = ${ARTIFACT_MAX_FILES}; maxf = ${ARTIFACT_MAX_FILE_BYTES}; maxt = ${ARTIFACT_MAX_TOTAL_BYTES}`,
  'full = resolve(a["dir"])',
  'if not os.path.isdir(full): out({"error": "not_found", "message": "no such directory: " + a["dir"]})',
  'res = []; total = 0',
  'for d, dirs, files in os.walk(full, followlinks=False):',
  '    dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x != "node_modules" and not os.path.islink(os.path.join(d, x)))',
  '    for n in sorted(files):',
  '        fp = os.path.join(d, n)',
  '        try: st = os.lstat(fp)',
  '        except OSError: continue',
  '        if not stat.S_ISREG(st.st_mode): continue',
  '        rel = os.path.relpath(fp, full).replace(os.sep, "/")',
  '        if len(res) >= maxn: out({"error": "too_many", "message": "more than " + str(maxn) + " files under " + a["dir"]})',
  '        total += st.st_size',
  '        if st.st_size > maxf or total > maxt: out({"error": "too_large", "path": rel})',
  '        res.append({"path": rel, "size": st.st_size})',
  'res.sort(key=lambda e: e["path"])',
  'out({"files": res})'
])

/** For each item {path, offset, length}: a header line {path, size} then the base64 of the piece. */
export const BUNDLE_READ_SCRIPT = py([
  ...PRELUDE,
  'import base64',
  `cap = ${CHUNK_BYTES}`,
  'items = a["items"]',
  'if sum(max(0, int(i.get("length") or 0)) for i in items) > cap: out({"error": "bad_input", "message": "read batch too large"})',
  'base = resolve(a["dir"])',
  'for it in items:',
  '    p = it["path"]',
  '    if not isinstance(p, str) or not p or p.startswith("/") or ".." in p.split("/"): out({"error": "bad_path", "message": "bad path"})',
  '    full = os.path.realpath(os.path.join(base, p))',
  '    if full != root and not full.startswith(root + os.sep): out({"error": "bad_path", "message": "the path leads outside the workspace"})',
  '    try: st = os.stat(full)',
  '    except OSError: out({"error": "not_found", "message": p + " is gone"})',
  '    if not stat.S_ISREG(st.st_mode): out({"error": "not_found", "message": p + " is not a regular file"})',
  '    off = max(0, int(it.get("offset") or 0)); ln = max(0, int(it.get("length") or 0))',
  '    data = b""',
  '    if ln:',
  '        with open(full, "rb") as f: f.seek(off); data = f.read(ln)',
  '    sys.stdout.write(json.dumps({"path": p, "size": st.st_size}) + "\\n" + base64.b64encode(data).decode("ascii") + "\\n")'
])

export type ReadPiece = { path: string; offset: number; length: number }

/** Pack file pieces into batches whose lengths sum to ≤ max; a bigger file is split across batches. */
export function planReads(files: Array<{ path: string; size: number }>, max: number = CHUNK_BYTES): ReadPiece[][] {
  const batches: ReadPiece[][] = []
  let cur: ReadPiece[] = []; let room = max
  for (const f of files) {
    let offset = 0; let left = f.size
    if (left === 0) { cur.push({ path: f.path, offset: 0, length: 0 }); continue }
    while (left > 0) {
      if (room === 0) { batches.push(cur); cur = []; room = max }
      const n = Math.min(left, room)
      cur.push({ path: f.path, offset, length: n })
      offset += n; left -= n; room -= n
    }
  }
  if (cur.length) batches.push(cur)
  return batches
}

type ExecFn = (script: string, input: unknown) => Promise<string>

function fail(j: { error?: string; message?: string; path?: string }, dir: string): never {
  const m = j.message ?? j.error ?? 'failed'
  switch (j.error) {
    case 'too_many': throw new ArtifactError(m, 'too_many')
    case 'too_large': throw new ArtifactError(`${j.path ?? 'a file'} exceeds the artifact limits (${ARTIFACT_MAX_FILE_BYTES / 1024 / 1024} MB per file, ${ARTIFACT_MAX_TOTAL_BYTES / 1024 / 1024} MB total)`, 'too_large')
    case 'not_found': throw new ArtifactError(m, 'not_found')
    case 'bad_path': case 'outside': throw new ArtifactError(`${JSON.stringify(dir)}: ${m}`, 'bad_path')
    default: throw new Error(`could not read ${dir}: ${m}`)
  }
}

export async function readWorkspaceBundle(
  workspaceId: string,
  dir: string,
  o: { tainted?: boolean; offline?: boolean; signal?: AbortSignal } = {}
): Promise<{ files: Array<{ path: string; content: Buffer }>; masked: number }> {
  if (executionMode() === 'remote') throw new Error('publishing from a workspace only works inside Bridget\'s runs')
  const exec: ExecFn = async (script, input) => {
    const r = await workspaceRuntime().manager.exec(workspaceId, script, {
      input: JSON.stringify(input), capBytes: 1024 * 1024, timeoutSec: 60,
      ...(o.tainted ? { tainted: true } : {}), ...(o.offline ? { offline: true } : {}), ...(o.signal ? { signal: o.signal } : {})
    })
    if (r.exitCode !== 0 || r.timedOut || r.truncated) throw new Error(`could not read ${dir}: ${r.timedOut ? 'timed out' : r.truncated ? 'the output was too large' : (r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`)}`)
    return r.stdout
  }

  // Fail closed up front: no point walking the tree when nothing could be masked.
  let values: string[]
  try { values = await secretValues() } catch (err) {
    if (err instanceof SecretStoreUnavailableError) throw new ArtifactError('publish refused — the secret store is unreadable, so secret values could not be masked', 'refused')
    throw err
  }

  const listed = JSON.parse(await exec(BUNDLE_LIST_SCRIPT, { dir })) as { files?: Array<{ path: string; size: number }>; error?: string; message?: string; path?: string }
  if (!listed.files) fail(listed, dir)

  const parts = new Map<string, Buffer[]>(listed.files.map(f => [f.path, []]))
  for (const batch of planReads(listed.files)) {
    const stdout = await exec(BUNDLE_READ_SCRIPT, { dir, items: batch })
    if (stdout.startsWith('{"error"')) fail(JSON.parse(stdout.split('\n')[0]!), dir)
    const lines = stdout.split('\n')
    batch.forEach((piece, i) => {
      const head = JSON.parse(lines[i * 2] ?? '{}') as { path?: string }
      if (head.path !== piece.path) throw new Error(`${piece.path} changed while publishing`)
      const data = Buffer.from(lines[i * 2 + 1] ?? '', 'base64')
      if (data.length !== piece.length) throw new Error(`${piece.path} changed while publishing`)
      parts.get(piece.path)!.push(data)
    })
  }

  let masked = 0
  const files = listed.files.map((f) => {
    let content = Buffer.concat(parts.get(f.path)!)
    if (content.length !== f.size) throw new Error(`${f.path} changed while publishing`)
    if (isTextPath(f.path)) {
      const text = content.toString('utf8')
      const m = maskText(text, values)
      if (m !== text) { masked++; content = Buffer.from(m, 'utf8') }
    }
    return { path: f.path, content }
  })
  return { files, masked }
}
