// Cycle 82 Task 2: the commands the workspace tools run INSIDE the sandbox (spec §2 path safety:
// nothing is ever resolved on the host). Pure builders — the tools hand them to the manager's exec.
//
// Data never travels in argv: paths, contents, patterns and old/new strings go in as JSON on stdin
// (a single argv string is capped at 128 KB, and argv is visible in /proc to every process in the
// sandbox). The scripts are fixed text; the python ones read `{...}` from stdin and print one JSON
// object. Relative paths resolve against the command's cwd, which is always /workspace.

/** POSIX single-quote a string for a shell command line. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Directory (relative to /workspace) holding the workspace's own bookkeeping — hidden from the
 *  listing / grep / diff tools. */
export const META_DIR = '.mymind'
export const SHELLS_DIR = `${META_DIR}/shells`

const py = (script: string) => `python3 -c ${shq(script)}`

const PY_PRELUDE = [
  'import sys, os, json, stat',
  'sys.stdout.reconfigure(encoding="utf-8", errors="replace")',
  'a = json.load(sys.stdin)',
  'def out(o):',
  '    sys.stdout.write(json.dumps(o, ensure_ascii=False)); sys.exit(0)'
].join('\n')

// ── read_file ──────────────────────────────────────────────────────────────────────────────────

export const READ_MAX_LINES = 2000
export const READ_MAX_LINE_CHARS = 2000
/** Bytes of numbered text one read_file returns at most (JSON-escaped it stays under READ_CAP_BYTES). */
export const READ_MAX_BYTES = 100_000
export const READ_CAP_BYTES = 256 * 1024

export const READ_SCRIPT = py([
  PY_PRELUDE,
  'p = a["path"]; off = max(1, int(a.get("offset") or 1)); lim = max(1, min(int(a.get("limit") or 2000), 2000))',
  `maxb = ${READ_MAX_BYTES}; maxc = ${READ_MAX_LINE_CHARS}`,
  'try: st = os.stat(p)',
  'except FileNotFoundError: out({"error": "not_found"})',
  'except PermissionError: out({"error": "permission_denied"})',
  'if stat.S_ISDIR(st.st_mode): out({"error": "is_directory"})',
  'if not stat.S_ISREG(st.st_mode): out({"error": "not_a_regular_file"})',
  'with open(p, "rb") as f: head = f.read(8192)',
  'if b"\\0" in head: out({"binary": True, "bytes": st.st_size})',
  'lines = []; used = 0; total = 0; truncated = False',
  'with open(p, "rb") as f:',
  '    for i, raw in enumerate(f, start=1):',
  '        total = i',
  '        if i < off or len(lines) >= lim or truncated: continue',
  '        t = raw.decode("utf-8", "replace").rstrip("\\n").rstrip("\\r")',
  '        if len(t) > maxc: t = t[:maxc] + " … [line truncated]"',
  '        s = "%6d\\t%s" % (i, t)',
  '        n = len(s.encode("utf-8")) + 1',
  '        if used + n > maxb: truncated = True; continue',
  '        lines.append(s); used += n',
  'out({"content": "\\n".join(lines), "startLine": off, "lines": len(lines), "totalLines": total, "truncated": truncated or (off + len(lines) - 1 < total), "bytes": st.st_size})'
].join('\n'))

// ── write_file ─────────────────────────────────────────────────────────────────────────────────

/** Largest content write_file / edit_file / import_document accept (the 1 GiB RLIMIT is the hard cap). */
export const WRITE_MAX_BYTES = 5 * 1024 * 1024

export const WRITE_SCRIPT = py([
  PY_PRELUDE,
  'p = a["path"]; c = a["content"]',
  'd = os.path.dirname(p)',
  'try:',
  '    if d: os.makedirs(d, exist_ok=True)',
  '    if os.path.isdir(p): out({"error": "is_directory"})',
  '    created = not os.path.exists(p)',
  '    with open(p, "w", encoding="utf-8", newline="") as f: f.write(c)',
  'except PermissionError: out({"error": "permission_denied"})',
  'except OSError as e: out({"error": "os_error", "message": str(e)})',
  'out({"ok": True, "path": os.path.abspath(p), "bytes": len(c.encode("utf-8")), "created": created})'
].join('\n'))

// ── edit_file ──────────────────────────────────────────────────────────────────────────────────

export const EDIT_SCRIPT = py([
  PY_PRELUDE,
  'p = a["path"]; old = a["old"]; new = a["new"]; every = bool(a.get("all"))',
  'if old == new: out({"error": "no_change", "message": "old_string and new_string are identical"})',
  'try:',
  '    with open(p, "rb") as f: raw = f.read()',
  'except FileNotFoundError: out({"error": "not_found"})',
  'except IsADirectoryError: out({"error": "is_directory"})',
  'except PermissionError: out({"error": "permission_denied"})',
  'if b"\\0" in raw[:8192]: out({"error": "binary", "message": "binary file — use bash to change it"})',
  'try: text = raw.decode("utf-8")',
  'except UnicodeDecodeError: out({"error": "not_utf8", "message": "not UTF-8 text — use bash to change it"})',
  'n = text.count(old)',
  'if n == 0: out({"error": "no_match", "message": "old_string was not found (it must match exactly, whitespace included)"})',
  'if n > 1 and not every:',
  '    lines = []; i = text.find(old)',
  '    while i != -1 and len(lines) < 10: lines.append(text.count("\\n", 0, i) + 1); i = text.find(old, i + 1)',
  '    out({"error": "ambiguous_match", "message": "old_string appears %d times — add surrounding lines to make it unique, or pass replace_all" % n, "count": n, "candidates": lines})',
  'res = text.replace(old, new) if every else text.replace(old, new, 1)',
  'try:',
  '    with open(p, "w", encoding="utf-8", newline="") as f: f.write(res)',
  'except OSError as e: out({"error": "os_error", "message": str(e)})',
  'out({"ok": True, "path": os.path.abspath(p), "replacements": n if every else 1, "bytes": len(res.encode("utf-8"))})'
].join('\n'))

// ── list_files ─────────────────────────────────────────────────────────────────────────────────

export const LIST_MAX = 500
const NOISE = ['.git', META_DIR, 'node_modules', '__pycache__', '.venv', '.mypy_cache', '.pytest_cache']

export const LIST_SCRIPT = py([
  PY_PRELUDE,
  'import pathlib',
  `root = a.get("path") or "."; pat = a.get("glob"); cap = ${LIST_MAX}; noise = set(${JSON.stringify(NOISE)})`,
  'if not os.path.exists(root): out({"error": "not_found"})',
  'if not os.path.isdir(root): out({"error": "not_a_directory"})',
  'res = []; more = False',
  'def skip(rel): return any(part in noise for part in pathlib.PurePath(rel).parts)',
  'if pat:',
  '    for m in pathlib.Path(root).glob(pat):',
  '        rel = os.path.relpath(str(m), root)',
  '        if skip(rel): continue',
  '        if len(res) >= cap: more = True; break',
  '        res.append(rel + ("/" if m.is_dir() else ""))',
  'else:',
  '    for d, dirs, files in os.walk(root):',
  '        dirs[:] = sorted(x for x in dirs if x not in noise)',
  '        for f in sorted(files):',
  '            if len(res) >= cap: more = True; break',
  '            res.append(os.path.relpath(os.path.join(d, f), root))',
  '        if more: break',
  'out({"root": os.path.abspath(root), "entries": sorted(res), "count": len(res), "truncated": more})'
].join('\n'))

// ── grep ───────────────────────────────────────────────────────────────────────────────────────

export const GREP_MAX = 200

/** ripgrep, ≤ GREP_MAX matching lines (+1 to know there were more). Exit 0 = matches, 1 = none,
 *  2 = error (bad regex…), 141 = more lines than the cap (head closed the pipe). */
export function grepCommand(o: { pattern: string; path?: string; glob?: string }): string {
  const args = ['rg', '--line-number', '--no-heading', '--color', 'never', '--hidden', '--max-columns', '300', '--max-columns-preview',
    ...NOISE.flatMap(n => ['-g', `!${n}`]), ...(o.glob ? ['-g', o.glob] : []), '-e', o.pattern, '--', o.path || '.']
  return `${args.map(shq).join(' ')} | head -n ${GREP_MAX + 1}; exit "\${PIPESTATUS[0]}"`
}

// ── diff ───────────────────────────────────────────────────────────────────────────────────────

export const DIFF_MAX_BYTES = 60_000
export const DIFF_INIT_MARK = '__mm_git_init__'
export const DIFF_BYTES_MARK = '__mm_diff_bytes__:'

/** `git diff` of the working tree; on first use the workspace becomes a git repo with a baseline
 *  commit (so later diffs show what changed since). New files show via intent-to-add. */
export function diffCommand(path?: string): string {
  const g = `git -c safe.directory='*' -c user.name=Bridget -c user.email=bridget@sandbox.invalid -c core.pager=cat -c color.ui=never`
  return [
    'set -e',
    `if [ ! -d .git ]; then ${g} init -q; printf '%s\\n' ${shq(`${META_DIR}/`)} >> .git/info/exclude; ${g} add -A; ${g} commit -q --allow-empty -m 'workspace baseline'; echo ${DIFF_INIT_MARK}; fi`,
    `${g} add -A -N 2>/dev/null || true`,
    `${g} diff --no-color${path ? ` -- ${shq(path)}` : ''} > /tmp/.mm-diff`,
    `n=$(wc -c < /tmp/.mm-diff); head -c ${DIFF_MAX_BYTES} /tmp/.mm-diff; printf '\\n${DIFF_BYTES_MARK}%s\\n' "$n"`
  ].join('\n')
}

export function parseDiff(stdout: string): { initialized: boolean; diff: string; bytes: number; truncated: boolean } {
  const initialized = stdout.includes(DIFF_INIT_MARK)
  let body = stdout.replace(`${DIFF_INIT_MARK}\n`, '')
  const at = body.lastIndexOf(`\n${DIFF_BYTES_MARK}`)
  let bytes = 0
  if (at >= 0) { bytes = Number(body.slice(at + 1 + DIFF_BYTES_MARK.length).trim()) || 0; body = body.slice(0, at) }
  return { initialized, diff: body, bytes, truncated: bytes > DIFF_MAX_BYTES }
}

// ── background shells ──────────────────────────────────────────────────────────────────────────

const SHELL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function shellDir(id: string): string {
  if (!SHELL_ID.test(id)) throw new Error(`bad shell id ${id}`)
  return `${SHELLS_DIR}/${id}`
}
export const SHELL_PID_MARK = '__mm_shell_pid__:'
export const SHELL_STATUS_MARK = '__mm_shell__:'

/**
 * Start a background shell: the command (on stdin) is saved as `<dir>/cmd` and run by a `setsid`
 * session leader (its own process group — kill_shell kills the group) with output to `<dir>/out`
 * and its exit code to `<dir>/exit` (written atomically). The launcher returns at once with the pid.
 * The leader's argv carries the dir, so a reused pid after a restart is never mistaken for it.
 */
export function shellStartCommand(id: string): string {
  const d = shellDir(id)
  const leader = 'echo $$ > "$1/pid"; /bin/bash "$1/cmd" > "$1/out" 2>&1 < /dev/null; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"'
  return [
    `d="$PWD/${d}"; mkdir -p "$d"; cat > "$d/cmd"`,
    `setsid /bin/sh -c ${shq(leader)} mm-shell "$d" > /dev/null 2>&1 < /dev/null &`,
    'i=0; while [ ! -s "$d/pid" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
    `printf '${SHELL_PID_MARK}%s\\n' "$(cat "$d/pid" 2>/dev/null)"`
  ].join('\n')
}

/** Is the shell's leader alive (pid + argv check), exited (code), or gone (no exit code)? */
function shellStatusLines(d: string): string[] {
  return [
    `d="$PWD/${d}"`,
    'st=missing; p=$(cat "$d/pid" 2>/dev/null || true)',
    'if [ -n "$p" ] && tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null | grep -qF "mm-shell $d"; then st=running',
    'elif [ -f "$d/exit" ]; then st="exit:$(cat "$d/exit")"',
    'elif [ -d "$d" ]; then st=gone; fi',
    'sz=$(stat -c %s "$d/out" 2>/dev/null || echo 0)'
  ]
}

/** Status + the output from byte `offset` on (at most `max` bytes). */
export function shellOutputCommand(id: string, offset: number, max: number): string {
  const off = Math.max(0, Math.floor(offset))
  const m = Math.max(1, Math.floor(max))
  return [
    ...shellStatusLines(shellDir(id)),
    `n=$((sz - ${off})); [ "$n" -gt ${m} ] && n=${m}; [ "$n" -lt 0 ] && n=0`,
    `printf '${SHELL_STATUS_MARK}%s:%s:%s\\n' "$st" "$sz" "$n"`,
    `[ "$n" -gt 0 ] && tail -c +${off + 1} "$d/out" | head -c "$n"; exit 0`
  ].join('\n')
}

/** Status only (boot reconcile). */
export function shellStatusCommand(id: string): string {
  return [...shellStatusLines(shellDir(id)), `printf '${SHELL_STATUS_MARK}%s:%s:0\\n' "$st" "$sz"`].join('\n')
}

/** TERM the shell's process group, then KILL it after a second. */
export function shellKillCommand(id: string): string {
  return [
    ...shellStatusLines(shellDir(id)),
    'if [ "$st" = running ]; then kill -TERM -"$p" 2>/dev/null || true; sleep 1; kill -KILL -"$p" 2>/dev/null || true; kill -KILL "$p" 2>/dev/null || true; fi',
    `printf '${SHELL_STATUS_MARK}%s:%s:0\\n' "$st" "$sz"`
  ].join('\n')
}

export type ShellStatus = { state: 'running' } | { state: 'exited'; exitCode: number } | { state: 'gone' } | { state: 'missing' }

export function parseShellStatus(stdout: string): { status: ShellStatus; size: number; n: number; output: string } | null {
  const i = stdout.indexOf(SHELL_STATUS_MARK)
  if (i < 0) return null
  const nl = stdout.indexOf('\n', i)
  const head = stdout.slice(i + SHELL_STATUS_MARK.length, nl < 0 ? undefined : nl)
  const m = head.match(/^(running|gone|missing|exit:(-?\d+)):(\d+):(\d+)$/)
  if (!m) return null
  const status: ShellStatus = m[2] !== undefined ? { state: 'exited', exitCode: Number(m[2]) } : { state: m[1] as 'running' | 'gone' | 'missing' }
  return { status, size: Number(m[3]), n: Number(m[4]), output: nl < 0 ? '' : stdout.slice(nl + 1) }
}

// ── watch polls ────────────────────────────────────────────────────────────────────────────────

export const WATCH_TAIL_BYTES = 4000

/** One poll: run the command (stdin JSON {command, pattern?, timeout}) and report its exit code,
 *  whether `pattern` matched its output (the regex runs HERE, inside the sandbox, so a pathological
 *  pattern can only burn the sandbox's own CPU until the poll times out — never the worker's event
 *  loop), and the output's tail. */
export const WATCH_POLL_SCRIPT = py([
  PY_PRELUDE,
  'import subprocess, re',
  'try:',
  '    r = subprocess.run(["/bin/bash", "-c", a["command"]], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=a["timeout"], start_new_session=True)',
  '    code = r.returncode; o = r.stdout',
  'except subprocess.TimeoutExpired as e:',
  '    code = None; o = e.output or b""',
  't = o.decode("utf-8", "replace")',
  'm = bool(re.search(a["pattern"], t, re.M)) if a.get("pattern") else None',
  `out({"exit": code, "matched": m, "tail": t[-${WATCH_TAIL_BYTES}:]})`
].join('\n'))

// ── over quota: what `bash` may still run ──────────────────────────────────────────────────────

/** Commands that only inspect or delete — what `bash` accepts while the workspace is over quota. */
// Not `uniq` (its 2nd operand is an output file) nor `file` (-C writes a magic file).
const RECOVERY_COMMANDS = new Set(['rm', 'rmdir', 'du', 'df', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'stat', 'pwd', 'echo', 'true', 'sort'])
/** find actions that write or run something. */
const FIND_UNSAFE = /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/

/**
 * Over quota (cycle 82 Task 2 decision): `bash` refuses anything that could write, but a pipeline
 * of inspection / deletion commands still runs so Bridget can free space herself. Conservative by
 * construction: plain words only — no redirection, substitution, globbing into another command,
 * subshells, variables or background — and every pipeline stage must start with an allowed command
 * (find without its exec/print-to-file actions).
 */
export function isRecoveryCommand(command: string): boolean {
  const c = command.trim()
  if (!c || c.length > 2000) return false
  // Anything that can redirect, substitute, expand into code, or start a subshell/background job.
  if (/[<>`$(){}\\&\n]/.test(c.replace(/&&/g, ''))) return false
  for (const stage of c.split(/\|\||&&|\||;/)) {
    const words = stage.trim().split(/\s+/).filter(Boolean)
    if (!words.length) return false
    const [cmd, ...rest] = words
    if (!RECOVERY_COMMANDS.has(cmd!)) return false
    const bare = rest.map(w => w.replace(/^['"]|['"]$/g, ''))
    if (cmd === 'find' && bare.some(w => FIND_UNSAFE.test(w))) return false
    if (cmd === 'sort' && bare.some(w => /^(-[a-zA-Z]*o|--output)/.test(w))) return false
  }
  return true
}
export const RECOVERY_COMMAND_LIST = [...RECOVERY_COMMANDS].join(', ')

// ── export_to_document: a whole text file ──────────────────────────────────────────────────────

/** Largest file export_to_document copies into a MyMind document. */
export const EXPORT_MAX_BYTES = 400_000

export const READ_TEXT_SCRIPT = py([
  PY_PRELUDE,
  `p = a["path"]; cap = ${EXPORT_MAX_BYTES}`,
  'try: st = os.stat(p)',
  'except FileNotFoundError: out({"error": "not_found"})',
  'except PermissionError: out({"error": "permission_denied"})',
  'if not stat.S_ISREG(st.st_mode): out({"error": "not_a_regular_file"})',
  'if st.st_size > cap: out({"error": "too_large", "message": "%d bytes (the limit is %d)" % (st.st_size, cap)})',
  'with open(p, "rb") as f: raw = f.read(cap + 1)',
  'if b"\\0" in raw[:8192]: out({"error": "binary", "message": "binary file — only text can become a document"})',
  'try: text = raw.decode("utf-8")',
  'except UnicodeDecodeError: out({"error": "not_utf8", "message": "not UTF-8 text"})',
  'out({"content": text, "bytes": len(raw), "path": os.path.abspath(p)})'
].join('\n'))
/** JSON-escaped (≤ 2× for text), an export-sized file stays under this. */
export const READ_TEXT_CAP_BYTES = 1024 * 1024
