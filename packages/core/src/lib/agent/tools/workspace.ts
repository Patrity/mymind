// Cycle 82 Task 2 (spec §4): the `workspace` toolset — Bridget's files, shell, background shells and
// watches, all INSIDE her Docker sandbox (lib/sandbox). On demand for chat, pre-loaded for workstreams.
//
//   Which workspace: a run in a workstream's thread → that workstream's; anything else → the single
//   `home` workspace (sandbox/runtime.ts resolveWorkspace; both created on first use).
//   No approvals (D4) and not `outbound`: the sandbox's network is governed by taint (D5) —
//   a TAINTED run (it read mail/calendar/contacts) runs every workspace command in a one-off
//   `--network none` container, which also taints the workspace persistently (manager.ts). EVERY tool
//   passes the run's taint, reads included: any command in the networked container exposes its
//   arguments (/proc) to whatever a previous run left running there. Background shells and watches
//   are refused in a tainted run (a one-off container can't outlive the command).
//   Results are untrusted data. A result from a tainted workspace carries `workspaceTainted: true`
//   FIRST — that taints the reading run (ai-tools.ts), since the files may be mail-derived.
//   Not on /api/mcp: these tools live on bridgetProfile only (profile.ts), and MCP excludes the toolset.
//
// Over quota (fix round 1, I1 ruling — deny by default): every command-running or writing tool is
// refused, `bash` in every mode included. Recovery is `list_files({largest: true})` (where the space
// went, with sizes) + `delete_files({paths})` (array args, `rm -rf --` inside the container), which
// work over quota. The hard limits stay underneath regardless: RLIMIT_FSIZE 1 GiB per file and the
// 5s free-space watchdog.
import { z } from 'zod'
import type { AgentTool, ToolContext, ToolExecution } from '../types'
import {
  DELETE_MAX_PATHS, DELETE_SCRIPT, EDIT_SCRIPT, LIST_SCRIPT, READ_CAP_BYTES, READ_MAX_LINES, READ_SCRIPT, WRITE_MAX_BYTES, WRITE_SCRIPT, GREP_MAX,
  diffCommand, grepCommand, parseDiff
} from '../../sandbox/fs-ops'
import { SandboxDiskLowError, SandboxQuotaError, SandboxUnavailableError, type ExecOptions, type SandboxExecResult } from '../../sandbox/manager'
import { readWorkspaceText, workspaceRuntime, type WorkspaceRef } from '../../sandbox/runtime'
import { WORKSPACE_UNTRUSTED_NOTE } from '../../sandbox/paths'
import { ShellError } from '../../sandbox/shells'
import { dbWorkspaceStore } from '../../sandbox/store'
import { WATCH_LIMITS, WatchError } from '../../sandbox/watches'
import { maskCut, maskDeep, maskText, sandboxSecretEnv, SecretStoreUnavailableError, secretValues } from '../../sandbox/secrets'
import { createDoc, deleteDoc, findDocByPath, getDoc, casUpdateContent, updateDoc } from '../../../services/documents'
import { publishChange } from '../../../utils/live-bus'
import { docReceipt, docNotFound } from '../receipt'

/** On every result that carries workspace content (shared with the watch wake notes). */
export { WORKSPACE_UNTRUSTED_NOTE }
const TAINTED_RUN = 'This conversation read Tony\'s mail, calendar or contacts, so workspace commands run without network'
const TAINTED_WS = 'This workspace handled mail/calendar content, so its network is off until Tony re-enables it (Workspace → Re-enable network)'

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The run's taint, read now. Absent (not called through buildAiTools) → fail closed. */
function runTainted(ctx: ToolContext): boolean {
  return ctx.isTainted ? ctx.isTainted() : true
}

interface Call { ref: WorkspaceRef; tainted: boolean; opts: ExecOptions }

/** Which workspace a tool call reached (set before any sandbox command runs) — guard() reads it to
 *  taint an ERROR result too (final review I1). */
interface Scope { workspaceId?: string }

async function begin(ctx: ToolContext, scope: Scope): Promise<Call> {
  const ref = await workspaceRuntime().resolve(ctx.runId)
  scope.workspaceId = ref.workspaceId
  const tainted = runTainted(ctx)
  return { ref, tainted, opts: { tainted, signal: ctx.signal } }
}

function exec(c: Call, command: string, o: ExecOptions = {}): Promise<SandboxExecResult> {
  return workspaceRuntime().manager.exec(c.ref.workspaceId, command, { ...c.opts, ...o })
}

/** `workspaceTainted` goes FIRST (tool-history.ts carriesWorkspaceTaint reads a capped preview). */
function withTaint<T extends Record<string, unknown>>(r: { tainted: boolean }, body: T): Record<string, unknown> {
  return r.tainted ? { workspaceTainted: true, ...body } : body
}

/** Known sandbox refusals become a clear tool error instead of a thrown one. Every result and
 *  summary has exec-secret VALUES masked (Task 3, spec §6: an opted-in secret is in the command's
 *  env, so `env` or a file it wrote would otherwise hand it to the model and the transcript). */
async function guard(name: string, ctx: ToolContext, fn: (scope: Scope) => Promise<ToolExecution>): Promise<ToolExecution> {
  const withheld = (): ToolExecution => ({ result: { ok: false, error: `${name}: output withheld — the secret store is unreadable, so secret values could not be masked` }, summary: `${name}: output withheld (secret store unreadable)` })
  const scope: Scope = {}
  let ex: ToolExecution
  try { ex = await fn(scope) } catch (err) {
    // Fix round 2: a handler (or the shell registry) that needed the values mid-call fails closed
    // the same way as the final mask below — never a raw error.
    if (err instanceof SecretStoreUnavailableError) return withheld()
    const known = err instanceof SandboxUnavailableError || err instanceof SandboxQuotaError || err instanceof SandboxDiskLowError
      || err instanceof ShellError || err instanceof WatchError || (err as Error)?.name === 'WorkspaceFileError'
    if (!known) throw err
    const message = (err as Error).message
    // Final review I1: these messages can carry sandbox text (stderr, a script's message) — an
    // error from a tainted workspace (or a tainted run) is marked exactly like a success result, so
    // it taints the reading run (ai-tools) and seeds the next one (tool-history).
    const tainted = scope.workspaceId !== undefined && await errorTainted(ctx, scope.workspaceId)
    ex = { result: tainted ? { workspaceTainted: true, ok: false, error: message } : { ok: false, error: message }, summary: `${name}: ${clip(message, 120)}` }
  }
  let values: string[]
  // Fail closed: when the values can't be read, nothing they might be in is shown.
  try { values = await secretValues() } catch { return withheld() }
  return { ...ex, result: maskDeep(ex.result, values), summary: maskDeep(ex.summary, values) }
}

/** An error result from this workspace must carry the taint flag: the run is tainted, or the
 *  workspace is (fail closed — an unreadable row counts as tainted). */
async function errorTainted(ctx: ToolContext, workspaceId: string): Promise<boolean> {
  if (runTainted(ctx)) return true
  try { return (await dbWorkspaceStore.get(workspaceId))?.tainted !== false } catch { return true }
}

/** Opted-in sandbox secrets for a command — none when the run OR the workspace is tainted (the
 *  manager drops them for tainted commands too; this is the first gate). */
async function secretsFor(c: Call): Promise<Pick<ExecOptions, 'secrets'>> {
  if (c.tainted || (await dbWorkspaceStore.get(c.ref.workspaceId))?.tainted) return {}
  const secrets = await sandboxSecretEnv({ tainted: false })
  return Object.keys(secrets).length ? { secrets } : {}
}

/** Fix round 1 (M1): output that was CUT inside the sandbox — lines shortened at a marker, a capped
 *  stream — is masked whole and has the cut edge trimmed here, before guard()'s final mask, so a
 *  secret straddling the cut can't come out as a visible half. */
const LINE_CUT_MARKERS = [' … [line truncated]', ' [... omitted end of long line]']
function maskLineCuts(text: string, values: string[]): string {
  if (!values.length) return text
  return text.split('\n').map((line) => {
    for (const m of LINE_CUT_MARKERS) if (line.endsWith(m)) return maskCut(line.slice(0, -m.length), values, { end: true }) + m
    return line
  }).join('\n')
}

function parseJson(r: SandboxExecResult): Record<string, unknown> | null {
  if (r.exitCode !== 0) return null
  try { return JSON.parse(r.stdout) as Record<string, unknown> } catch { return null }
}

function failed(name: string, r: SandboxExecResult): ToolExecution {
  const why = r.timedOut ? 'timed out' : r.oom ? 'ran out of memory' : r.truncated ? 'its output was too large' : (r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`)
  return { result: withTaint(r, { ok: false, error: `${name} failed: ${why}` }), summary: `${name} failed` }
}

/** A script's own `{error}` result → the tool's. */
function scriptError(name: string, r: SandboxExecResult, j: Record<string, unknown>, path?: string): ToolExecution | null {
  if (typeof j.error !== 'string') return null
  const message = typeof j.message === 'string' ? j.message : j.error.replace(/_/g, ' ')
  return { result: withTaint(r, { ok: false, error: j.error, message, ...(path ? { path } : {}), ...(j.candidates ? { candidates: j.candidates, count: j.count } : {}) }), summary: `${name}: ${message}${path ? ` (${clip(path, 60)})` : ''}` }
}

async function overQuota(c: Call): Promise<SandboxQuotaError | null> {
  try { await workspaceRuntime().manager.checkQuota(c.ref.workspaceId, { tainted: c.tainted }); return null } catch (err) {
    if (err instanceof SandboxQuotaError) return err
    throw err
  }
}

async function assertQuota(c: Call): Promise<void> {
  const q = await overQuota(c)
  if (q) throw q
}

function byteLen(s: string): number { return Buffer.byteLength(s, 'utf8') }

const pathArg = z.string().min(1).max(4096)

export const readFileTool: AgentTool = {
  name: 'read_file',
  toolset: 'workspace',
  kind: 'read',
  description: `Read a text file in your workspace, with line numbers (≤ ${READ_MAX_LINES} lines per call; pass offset/limit for more). Paths are relative to /workspace (absolute paths are inside the sandbox). Binary files are detected and not shown.`,
  schema: {
    path: pathArg.describe('File path (relative to /workspace)'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
    limit: z.number().int().min(1).max(READ_MAX_LINES).optional().describe(`Lines to read (max ${READ_MAX_LINES})`)
  },
  handler: (a, ctx) => guard('read_file', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    const path = a.path as string
    const r = await exec(c, READ_SCRIPT, { input: JSON.stringify({ path, offset: a.offset, limit: a.limit }), capBytes: READ_CAP_BYTES, timeoutSec: 60 })
    const j = parseJson(r)
    if (!j) return failed('read_file', r)
    const err = scriptError('read_file', r, j, path)
    if (err) return err
    if (j.binary) return { result: withTaint(r, { path, binary: true, bytes: j.bytes, message: 'binary file — not shown (use bash, e.g. `file`, `xxd | head`)' }), summary: `read_file: ${clip(path, 60)} is binary` }
    if (typeof j.content === 'string') j.content = maskLineCuts(j.content, await secretValues())
    return {
      result: withTaint(r, { path, ...j, note: WORKSPACE_UNTRUSTED_NOTE }),
      summary: `read ${clip(path, 60)} (${j.lines} line${j.lines === 1 ? '' : 's'}${j.truncated ? ', more' : ''})`
    }
  })
}

export const writeFileTool: AgentTool = {
  name: 'write_file',
  toolset: 'workspace',
  kind: 'create',
  description: 'Create or overwrite a text file in your workspace (parent directories are created). Prefer edit_file for small changes to an existing file. Returns a receipt, never the content.',
  schema: {
    path: pathArg.describe('File path (relative to /workspace)'),
    content: z.string().describe('The full file content')
  },
  handler: (a, ctx) => guard('write_file', ctx, async (scope) => {
    const path = a.path as string
    const content = a.content as string
    if (byteLen(content) > WRITE_MAX_BYTES) return { result: { ok: false, error: `content is ${byteLen(content)} bytes — the limit is ${WRITE_MAX_BYTES}; write it with bash instead` }, summary: 'write_file: too large' }
    const c = await begin(ctx, scope)
    await assertQuota(c)
    const r = await exec(c, WRITE_SCRIPT, { input: JSON.stringify({ path, content }), timeoutSec: 60 })
    const j = parseJson(r)
    if (!j) return failed('write_file', r)
    const err = scriptError('write_file', r, j, path)
    if (err) return err
    return { result: withTaint(r, j), summary: `${j.created ? 'created' : 'wrote'} ${clip(path, 60)} (${j.bytes} bytes)` }
  })
}

export const editFileTool: AgentTool = {
  name: 'edit_file',
  toolset: 'workspace',
  kind: 'create',
  description: 'Edit a text file in your workspace by exact find/replace. `old_string` must appear exactly once (add surrounding lines to make it unique) unless replace_all is set; on ambiguity the error lists the candidate line numbers. Read the file first to copy the exact text.',
  schema: {
    path: pathArg.describe('File path (relative to /workspace)'),
    old_string: z.string().min(1).describe('Exact text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace every occurrence')
  },
  handler: (a, ctx) => guard('edit_file', ctx, async (scope) => {
    const path = a.path as string
    if (byteLen(a.old_string as string) + byteLen(a.new_string as string) > WRITE_MAX_BYTES) return { result: { ok: false, error: 'edit too large — use write_file or bash' }, summary: 'edit_file: too large' }
    const c = await begin(ctx, scope)
    await assertQuota(c)
    const r = await exec(c, EDIT_SCRIPT, { input: JSON.stringify({ path, old: a.old_string, new: a.new_string, all: a.replace_all === true }), timeoutSec: 60 })
    const j = parseJson(r)
    if (!j) return failed('edit_file', r)
    const err = scriptError('edit_file', r, j, path)
    if (err) return err
    return { result: withTaint(r, j), summary: `edited ${clip(path, 60)} (${j.replacements} replacement${j.replacements === 1 ? '' : 's'})` }
  })
}

export const listFilesTool: AgentTool = {
  name: 'list_files',
  toolset: 'workspace',
  kind: 'read',
  description: 'List files in your workspace with their sizes (bytes on disk): every file under `path` (default /workspace), or the matches of a glob such as `**/*.py`. At most 500 entries; .git, node_modules, .venv and caches are skipped. `largest: true` instead shows where the space went — total, the 50 largest files and the largest directories (everything counted, node_modules included); use it with delete_files to get back under the quota.',
  schema: {
    glob: z.string().max(500).optional().describe('Glob relative to path, e.g. **/*.ts'),
    path: pathArg.optional().describe('Directory (relative to /workspace)'),
    largest: z.boolean().optional().describe('Show the largest files and directories instead of a listing')
  },
  handler: (a, ctx) => guard('list_files', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    const r = await exec(c, LIST_SCRIPT, { input: JSON.stringify({ glob: a.glob ?? null, path: a.path ?? null, largest: a.largest === true }), capBytes: 256 * 1024, timeoutSec: 120 })
    const j = parseJson(r)
    if (!j) return failed('list_files', r)
    const err = scriptError('list_files', r, j, a.path as string | undefined)
    if (err) return err
    if (a.largest === true) return { result: withTaint(r, { ...j, note: WORKSPACE_UNTRUSTED_NOTE }), summary: `workspace uses ${j.totalBytes} bytes in ${j.files} files` }
    return { result: withTaint(r, { ...j, note: WORKSPACE_UNTRUSTED_NOTE }), summary: `listed ${j.count} file${j.count === 1 ? '' : 's'}${j.truncated ? ' (more)' : ''}` }
  })
}

export const grepTool: AgentTool = {
  name: 'grep',
  toolset: 'workspace',
  kind: 'read',
  description: `Search file contents in your workspace with ripgrep (regex). Returns \`path:line:text\` lines, at most ${GREP_MAX}. Narrow with path and glob (e.g. *.py).`,
  schema: {
    pattern: z.string().min(1).max(1000).describe('Regular expression (ripgrep syntax)'),
    path: pathArg.optional().describe('File or directory (relative to /workspace)'),
    glob: z.string().max(500).optional().describe('Only files matching this glob, e.g. *.ts')
  },
  handler: (a, ctx) => guard('grep', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    const r = await exec(c, grepCommand({ pattern: a.pattern as string, path: a.path as string | undefined, glob: a.glob as string | undefined }), { capBytes: 128 * 1024, timeoutSec: 60 })
    if (r.timedOut) return failed('grep', r)
    if (r.exitCode === 1) return { result: withTaint(r, { matches: [], count: 0 }), summary: 'grep: no matches' }
    if (r.exitCode !== 0 && r.exitCode !== 141) return { result: withTaint(r, { ok: false, error: r.stderr.trim().slice(0, 500) || `exit ${r.exitCode}` }), summary: 'grep failed' }
    const lines = maskLineCuts(r.stdout, await secretValues()).split('\n').filter(Boolean)
    const truncated = lines.length > GREP_MAX || r.exitCode === 141
    const matches = lines.slice(0, GREP_MAX)
    return { result: withTaint(r, { matches, count: matches.length, truncated, note: WORKSPACE_UNTRUSTED_NOTE }), summary: `grep: ${matches.length}${truncated ? '+' : ''} match${matches.length === 1 ? '' : 'es'}` }
  })
}

export const diffTool: AgentTool = {
  name: 'diff',
  toolset: 'workspace',
  kind: 'read',
  description: 'Show what changed in your workspace (`git diff`, new files included). On first use the workspace becomes a git repo with a baseline commit, so later diffs show changes since then (commit with bash to move the baseline).',
  schema: { path: pathArg.optional().describe('Only this file or directory') },
  handler: (a, ctx) => guard('diff', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    // The first diff commits the whole workspace into .git — a copy of everything (quota).
    await assertQuota(c)
    const r = await exec(c, diffCommand(a.path as string | undefined), { capBytes: 128 * 1024, timeoutSec: 120 })
    if (r.exitCode !== 0) return failed('diff', r)
    const d = parseDiff(r.stdout)
    if (d.truncated) d.diff = maskCut(d.diff, await secretValues(), { end: true })
    const empty = !d.diff.trim()
    return {
      result: withTaint(r, { initialized: d.initialized, diff: d.diff, bytes: d.bytes, truncated: d.truncated, ...(d.initialized ? { note: `Started tracking the workspace with git (baseline commit). ${WORKSPACE_UNTRUSTED_NOTE}` } : { note: WORKSPACE_UNTRUSTED_NOTE }) }),
      summary: d.initialized && empty ? 'diff: baseline created' : empty ? 'diff: no changes' : `diff: ${d.bytes} bytes`
    }
  })
}

export const bashTool: AgentTool = {
  name: 'bash',
  toolset: 'workspace',
  kind: 'create',
  description: 'Run a bash command in your workspace sandbox (cwd /workspace; internet yes, LAN no; no root). Foreground: returns exit code + output (64 KB tail; timeout default 120s, max 600s). run_in_background: starts it and returns a shellId at once — read its output with bash_output, stop it with kill_shell; use `watch` to wait for it. Background shells are for jobs, not servers: after 15 min with no command and no output read (and no armed watch) the sandbox stops and its shells with it; they also end when the workstream ends.',
  schema: {
    command: z.string().min(1).max(100_000).describe('The bash command'),
    timeout: z.number().int().min(1).max(600).optional().describe('Foreground timeout in seconds (default 120, max 600)'),
    run_in_background: z.boolean().optional().describe('Start it in the background and return a shellId')
  },
  handler: (a, ctx) => guard('bash', ctx, async (scope) => {
    const command = a.command as string
    const c = await begin(ctx, scope)
    if (a.run_in_background === true) {
      if (c.tainted) return { result: { ok: false, error: `${TAINTED_RUN} in a throwaway container — background shells are not available. Run it in the foreground (timeout up to 600s).` }, summary: 'bash: background refused (tainted run)' }
      if ((await dbWorkspaceStore.get(c.ref.workspaceId))?.tainted) return { result: { ok: false, error: `${TAINTED_WS} — background shells need it. Run it in the foreground instead.` }, summary: 'bash: background refused (workspace offline)' }
      await assertQuota(c)
      const s = await workspaceRuntime().shells.start(c.ref.workspaceId, command, await secretsFor(c))
      return { result: { shellId: s.shellId, pid: s.pid, state: 'running', note: 'Read its output with bash_output({shellId}); stop it with kill_shell. To wait for it without polling, use watch.' }, summary: `started in background: \`${clip(command)}\`` }
    }
    const q = await overQuota(c)
    if (q) return { result: { ok: false, error: `${q.message} — bash is refused until space is freed. Find what is big with list_files({ largest: true }), then remove it with delete_files({ paths: [...] }).` }, summary: 'bash: refused (over quota)' }
    const r = await exec(c, command, { timeoutSec: a.timeout as number | undefined, ...(await secretsFor(c)) })
    // The 64 KB cap keeps the TAIL: whatever was cut came before it.
    if (r.truncated) { const v = await secretValues(); r.stdout = maskCut(r.stdout, v, { start: true }); r.stderr = maskCut(r.stderr, v, { start: true }) }
    return {
      result: withTaint(r, {
        exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
        ...(r.timedOut ? { timedOut: true } : {}), ...(r.oom ? { oom: true, note: 'killed: the sandbox ran out of memory (2 GB)' } : {}),
        ...(r.aborted ? { aborted: true } : {}), ...(r.truncated ? { truncated: true } : {}),
        ...(r.tainted ? { networkOff: true, networkNote: c.tainted ? `${TAINTED_RUN}.` : `${TAINTED_WS}.` } : {}),
        untrusted: WORKSPACE_UNTRUSTED_NOTE
      }),
      summary: `ran \`${clip(command)}\` → exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}${r.oom ? ' (out of memory)' : ''}${r.tainted ? ' (no network)' : ''}`
    }
  })
}

export const bashOutputTool: AgentTool = {
  name: 'bash_output',
  toolset: 'workspace',
  kind: 'read',
  description: 'New output of a background shell since the last call (≤ 32 KB; `more: true` means call again), plus its state (running / exited with exitCode / killed / lost).',
  schema: { shellId: z.string().uuid().describe('From bash with run_in_background') },
  handler: (a, ctx) => guard('bash_output', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    const o = await workspaceRuntime().shells.output(c.ref.workspaceId, a.shellId as string, c.opts)
    const { tainted: _t, ...body } = o
    return {
      result: withTaint(o, { ...body, untrusted: WORKSPACE_UNTRUSTED_NOTE }),
      summary: `shell ${o.state}${o.exitCode !== undefined ? ` (exit ${o.exitCode})` : ''}: ${o.output.length} new chars${o.more ? ', more' : ''}`
    }
  })
}

export const killShellTool: AgentTool = {
  name: 'kill_shell',
  toolset: 'workspace',
  kind: 'create',
  description: 'Stop a background shell (its whole process group).',
  schema: { shellId: z.string().uuid().describe('From bash with run_in_background') },
  handler: (a, ctx) => guard('kill_shell', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    const k = await workspaceRuntime().shells.kill(c.ref.workspaceId, a.shellId as string, c.opts)
    return { result: withTaint(k, { shellId: k.shellId, state: k.state, ...(k.alreadyEnded ? { alreadyEnded: true } : {}) }), summary: k.alreadyEnded ? `shell already ${k.state}` : `stopped shell (${k.state})` }
  })
}

export const deleteFilesTool: AgentTool = {
  name: 'delete_files',
  toolset: 'workspace',
  kind: 'create',
  description: `Delete files or directories (recursively) in your workspace — paths relative to /workspace, no \`..\`, at most ${DELETE_MAX_PATHS}; .mymind (MyMind's own bookkeeping) can't be deleted, and one invalid path refuses the whole batch (nothing is deleted). Works even when the workspace is over its quota (that is how you free space: find what is big with list_files({ largest: true }) first).`,
  schema: { paths: z.array(pathArg).min(1).max(DELETE_MAX_PATHS).describe('Relative paths to delete') },
  handler: (a, ctx) => guard('delete_files', ctx, async (scope) => {
    const c = await begin(ctx, scope)
    // No quota check: this is the way back under it.
    const r = await exec(c, DELETE_SCRIPT, { input: JSON.stringify({ paths: a.paths }), timeoutSec: 300 })
    const j = parseJson(r)
    if (!j) return failed('delete_files', r)
    // One invalid path refuses the whole batch before anything is deleted (final fix wave).
    const err = scriptError('delete_files', r, j)
    if (err) return err
    const deleted = j.deleted as string[]
    const refused = j.refused as unknown[]
    return { result: withTaint(r, j), summary: `deleted ${deleted.length} path${deleted.length === 1 ? '' : 's'}${refused.length ? `, refused ${refused.length}` : ''}` }
  })
}

export const watchTool: AgentTool = {
  name: 'watch',
  toolset: 'workspace',
  kind: 'create',
  description: 'Wait for a condition without polling yourself: the command is re-run in your workspace every intervalSec until it exits 0 (until: "exit0") or its output matches `pattern` (until: "match", a Python regex), or timeoutMin passes. Returns at once. In a workstream the result wakes the work — if there is nothing else to do meanwhile, end your turn and it waits without using budget. In chat a note is posted when it ends.',
  schema: {
    command: z.string().min(1).max(10_000).describe('Command to re-run (e.g. `test -f out/done` or `curl -s localhost:8000/health`)'),
    until: z.enum(['exit0', 'match']).describe('"exit0": done when it exits 0; "match": done when its output matches pattern'),
    pattern: z.string().min(1).max(500).optional().describe('Regex for until="match"'),
    intervalSec: z.number().int().min(WATCH_LIMITS.intervalSec.min).max(WATCH_LIMITS.intervalSec.max).optional().describe(`Seconds between polls (default ${WATCH_LIMITS.intervalSec.default})`),
    timeoutMin: z.number().int().min(WATCH_LIMITS.timeoutMin.min).max(WATCH_LIMITS.timeoutMin.max).optional().describe(`Give up after this many minutes (default ${WATCH_LIMITS.timeoutMin.default})`)
  },
  handler: (a, ctx) => guard('watch', ctx, async (scope) => {
    const until = a.until as 'exit0' | 'match'
    const pattern = a.pattern as string | undefined
    if (until === 'match' && !pattern) return { result: { ok: false, error: 'until="match" needs a pattern' }, summary: 'watch: no pattern' }
    const c = await begin(ctx, scope)
    if (c.tainted) return { result: { ok: false, error: `${TAINTED_RUN} in throwaway containers — watches are not available. Check with a foreground bash command instead.` }, summary: 'watch: refused (tainted run)' }
    if (!c.ref.workstreamId && !c.ref.conversationId) return { result: { ok: false, error: 'watch needs a conversation or workstream to report back to' }, summary: 'watch: nowhere to report' }
    // Fix round 1 (M2): a tainted workspace runs every poll in a fresh no-network container — no watches there.
    if ((await dbWorkspaceStore.get(c.ref.workspaceId))?.tainted) return { result: { ok: false, error: `${TAINTED_WS} — watches need it. Check with a foreground bash command instead.` }, summary: 'watch: refused (workspace offline)' }
    await assertQuota(c)
    if (until === 'match') {
      // Python's regex dialect (the poll matches inside the sandbox) — check it compiles now.
      const r = await exec(c, `python3 -I -c 'import re,sys; re.compile(sys.stdin.read())'`, { input: pattern, timeoutSec: 20 })
      if (r.exitCode !== 0) return { result: { ok: false, error: `invalid pattern: ${r.stderr.trim().split('\n').pop() ?? 'does not compile'}` }, summary: 'watch: invalid pattern' }
    }
    const intervalSec = (a.intervalSec as number | undefined) ?? WATCH_LIMITS.intervalSec.default
    const timeoutMin = (a.timeoutMin as number | undefined) ?? WATCH_LIMITS.timeoutMin.default
    const row = await workspaceRuntime().watches.create({
      workspaceId: c.ref.workspaceId, workstreamId: c.ref.workstreamId, conversationId: c.ref.conversationId,
      command: a.command as string, until: until === 'match' ? { kind: 'match', pattern: pattern! } : { kind: 'exit0' }, intervalSec, timeoutMin
    })
    if ('refused' in row) {
      if (row.refused === 'workspace' || !c.ref.workstreamId) return { result: { ok: false, error: row.message }, summary: 'watch: refused (limit)' }
      // Fix round 1 (I2): a workstream's lifetime watch caps — Tony decides whether it goes on.
      const why = `It reached its watch limit: ${row.message}. Watch waiting uses no budget, so this stops it from waiting indefinitely. Resume it (or reply in its thread) to continue without new watches, or cancel it.`
      const { pauseWorkstreamForTony } = await import('../workstreams/loop')
      await pauseWorkstreamForTony(ctx.runId, c.ref.workstreamId, why)
      return { result: { ok: false, error: `${row.message} — the workstream is now paused for Tony. Stop here.` }, summary: 'watch: limit reached — workstream paused for Tony' }
    }
    const clamped = row.deadlineAt.getTime() - row.createdAt.getTime() < timeoutMin * 60_000 - 1000
    return {
      result: {
        watchId: row.id, deadline: row.deadlineAt.toISOString(),
        ...(clamped ? { clamped: 'the timeout was shortened to what is left of this workstream\'s 48 h of watch waiting' } : {}),
        note: c.ref.workstreamId
          ? 'Armed. When it fires or times out, the result arrives in this workstream. If you have nothing else to do until then, end your turn with a short note — the workstream waits for it without using budget.'
          : 'Armed. When it fires or times out, a note is posted in this chat.'
      },
      summary: `watching \`${clip(a.command as string)}\` every ${intervalSec}s for up to ${timeoutMin} min`
    }
  })
}

const DOC_PATH = z.string().min(2).max(500).regex(/^\/[^\s].*\.md$/, 'an absolute document path ending in .md, e.g. /projects/x/report.md')

export const exportToDocumentTool: AgentTool = {
  name: 'export_to_document',
  toolset: 'workspace',
  kind: 'create',
  description: 'Copy a text file from your workspace into Tony\'s documents at docPath (creates the document, or replaces the content of the one already there). ≤ 400 KB of UTF-8 text.',
  schema: {
    path: pathArg.describe('Workspace file (relative to /workspace)'),
    docPath: DOC_PATH.describe('Document path, e.g. /projects/<slug>/report.md'),
    workspaceId: z.string().uuid().optional().describe('Set automatically — leave it out')
  },
  // Fix round 1 (M4): a headless proposal stores the workspace it was proposed from; the replay
  // (no run) reads from that one, never from whatever `home` resolves to.
  proposalArgs: async (args, ctx) => ({ ...args, workspaceId: (await workspaceRuntime().resolve(ctx.runId)).workspaceId }),
  handler: (a, ctx) => guard('export_to_document', ctx, async (scope) => {
    // A live call resolves from its run (a model-supplied workspaceId is ignored); a replay uses the
    // proposal's pinned one.
    let workspaceId: string
    if (ctx.runId || !a.workspaceId) workspaceId = (await workspaceRuntime().resolve(ctx.runId)).workspaceId
    else {
      const row = await dbWorkspaceStore.get(a.workspaceId as string)
      if (!row || row.deletedAt) return { result: { ok: false, error: 'the workspace this export was proposed from no longer exists' }, summary: 'export_to_document: workspace gone' }
      workspaceId = row.id
    }
    scope.workspaceId = workspaceId
    // Reading moves nothing off the box; the run's taint applies when there is one (replay has none).
    const f = await readWorkspaceText(workspaceId, a.path as string, { tainted: ctx.isTainted?.() ?? false, signal: ctx.signal })
    // Ruling C3: the document must not carry an opted-in secret a command wrote into the file —
    // values are masked before it is written. Fails closed: no readable store, no export.
    let values: string[]
    try { values = await secretValues() } catch {
      return { result: { ok: false, error: 'export refused — the secret store is unreadable, so secret values could not be masked out of the document' }, summary: 'export_to_document: refused (secret store unreadable)' }
    }
    const content = maskText(f.content, values)
    const docPath = a.docPath as string
    const existing = await findDocByPath(docPath)
    if (existing) {
      const prior = await getDoc(existing.id)
      if (!prior) return { result: docNotFound(existing.id), summary: 'export_to_document: document vanished' }
      const before = prior.content ?? ''
      const updated = await updateDoc(existing.id, { content })
      publishChange({ resource: 'document', action: 'updated', id: existing.id })
      return {
        result: updated ? withTaint(f, { ...docReceipt(updated, { before: before.length }), from: f.path, replaced: true }) : docNotFound(existing.id),
        summary: `exported ${clip(a.path as string, 50)} → ${docPath} (replaced)`,
        undo: async () => {
          if (!updated) return { ok: false, reason: 'the export did not land — nothing to undo' }
          const restored = await casUpdateContent(existing.id, before, updated.contentHash)
          if (!restored) return { ok: false, reason: 'document changed since the export — nothing was undone' }
          publishChange({ resource: 'document', action: 'updated', id: existing.id })
          return { ok: true }
        }
      }
    }
    const doc = await createDoc({ path: docPath, content })
    publishChange({ resource: 'document', action: 'created', id: doc.id })
    return {
      result: withTaint(f, { ...docReceipt(doc, { before: 0 }), from: f.path }),
      summary: `exported ${clip(a.path as string, 50)} → ${doc.path}`,
      undo: async () => { await deleteDoc(doc.id) }
    }
  })
}

export const importDocumentTool: AgentTool = {
  name: 'import_document',
  toolset: 'workspace',
  kind: 'create',
  description: 'Copy one of Tony\'s documents (by id) into your workspace as a file at path (overwrites).',
  schema: {
    docId: z.string().min(1).describe('Document id'),
    path: pathArg.describe('Workspace file to write (relative to /workspace)')
  },
  handler: (a, ctx) => guard('import_document', ctx, async (scope) => {
    const doc = await getDoc(a.docId as string)
    if (!doc) return { result: docNotFound(a.docId as string), summary: 'import_document: not found' }
    const content = doc.content ?? ''
    if (byteLen(content) > WRITE_MAX_BYTES) return { result: { ok: false, error: 'document too large to import' }, summary: 'import_document: too large' }
    const c = await begin(ctx, scope)
    await assertQuota(c)
    const r = await exec(c, WRITE_SCRIPT, { input: JSON.stringify({ path: a.path, content }), timeoutSec: 60 })
    const j = parseJson(r)
    if (!j) return failed('import_document', r)
    const err = scriptError('import_document', r, j, a.path as string)
    if (err) return err
    return { result: withTaint(r, { ...j, docId: doc.id, docPath: doc.path }), summary: `imported ${doc.path} → ${clip(a.path as string, 60)}` }
  })
}

/** Cycle 83: export_to_coordinator's limits — the archive travels base64 through the 1 MB output cap. */
export const EXPORT_MAX_PATHS = 100
export const EXPORT_DIR = 'from'
/** Fix round 1 (M4): at most this much unpacked per export (and never past the destination's quota). */
export const EXPORT_MAX_UNPACKED_BYTES = 200 * 1024 * 1024
const EXPORT_TOO_LARGE = '__mm_export_too_large__'

/** The unpack, run INSIDE the destination sandbox with the base64 archive on stdin: decompression is
 *  cut at `limit` bytes (exit 3), an archive holding anything but plain files and directories is
 *  refused before extraction (exit 4), and nothing extracts over an existing directory's metadata. */
export function exportUnpackCommand(dir: string, limit: number): string {
  return [
    't=$(mktemp) || exit 1',
    `base64 -d | gzip -dc | head -c ${limit + 1} > "$t"`,
    `if [ "$(wc -c < "$t")" -gt ${limit} ]; then rm -f "$t"; echo "${EXPORT_TOO_LARGE}" >&2; exit 3; fi`,
    `if tar -tvf "$t" | grep -q '^[^-d]'; then rm -f "$t"; echo "the archive holds links or special files" >&2; exit 4; fi`,
    // Fix round 2: the members' LISTED sizes count too — a sparse member lists far more than the
    // archive holds (2 GB from a few KB) and extracts to that apparent size. A plain archive always
    // holds every byte it lists, so listing more than the archive's own size means sparse: refused.
    `n=$(tar -tvf "$t" | awk '{s+=$3} END {printf "%d", s}')`,
    `if [ "$n" -gt ${limit} ]; then rm -f "$t"; echo "${EXPORT_TOO_LARGE}" >&2; exit 3; fi`,
    `if [ "$n" -gt "$(wc -c < "$t")" ]; then rm -f "$t"; echo "the archive holds sparse files" >&2; exit 5; fi`,
    `mkdir -p ${dir} && tar -xf "$t" -C ${dir} --no-same-owner --no-same-permissions --no-overwrite-dir; s=$?; rm -f "$t"; exit $s`
  ].join('\n')
}

/** null when `p` may be exported (relative, no `..`, not MyMind's bookkeeping); else why not. */
function exportPathProblem(p: string): string | null {
  if (!p || p.includes('\0')) return 'empty path'
  if (p.startsWith('/')) return 'paths are relative to /workspace (no leading /)'
  const parts = p.split('/').filter(x => x && x !== '.')
  if (!parts.length) return 'export named files or directories, not the whole workspace'
  if (parts.includes('..')) return 'no ..'
  if (parts[0] === '.mymind') return '.mymind is MyMind\'s own bookkeeping'
  return null
}

/**
 * Cycle 83 (spec D7): a CHILD workstream with its OWN workspace hands files up to its coordinator —
 * copied into the coordinator's workspace under /workspace/from/<childId>/. The copy is a tar of the
 * named paths made inside the child's sandbox (symlinks and hard links dereferenced, so the archive
 * holds plain files only) and unpacked inside the coordinator's — the worker never touches either
 * directory. A tainted run or a tainted child workspace taints the coordinator's workspace too (its
 * files may be mail-derived).
 */
export const exportToCoordinatorTool: AgentTool = {
  name: 'export_to_coordinator',
  toolset: 'workspace',
  kind: 'create',
  description: `Copy files or directories from your workspace into your coordinator's workspace (they land under ${EXPORT_DIR}/<your workstream id>/ there). Only for a child workstream with its own workspace. Paths relative to /workspace; at most ${EXPORT_MAX_PATHS}; about 700 KB compressed in total — for more, write a summary file and export that.`,
  schema: { paths: z.array(pathArg).min(1).max(EXPORT_MAX_PATHS).describe('Relative paths to copy') },
  handler: (a, ctx) => guard('export_to_coordinator', ctx, async (scope) => {
    const paths = a.paths as string[]
    for (const p of paths) {
      const why = exportPathProblem(p)
      if (why) return { result: { ok: false, error: `${p}: ${why}` }, summary: 'export_to_coordinator: bad path' }
    }
    const c = await begin(ctx, scope)
    const { getWorkstream } = await import('../workstreams/store')
    const child = c.ref.workstreamId ? await getWorkstream(c.ref.workstreamId) : null
    if (!child?.isChild) return { result: { ok: false, error: 'export_to_coordinator is only for a child workstream (this run has no coordinator)' }, summary: 'export_to_coordinator: not a child' }
    if (!child.parentId) return { result: { ok: false, error: 'your coordinator no longer exists' }, summary: 'export_to_coordinator: no coordinator' }
    if (child.workspaceMode !== 'own') return { result: { ok: false, error: 'you share your coordinator\'s workspace already — your files are there' }, summary: 'export_to_coordinator: shared workspace' }
    // Inside the child's sandbox: the file list on stdin (NUL-separated); out come the archive's
    // UNCOMPRESSED size (first line) and the gzip'd tar as base64. Via a temp file, not a pipe: the
    // sandbox's sh (dash) has no pipefail, so a tar error (a missing path) would otherwise be hidden.
    const pack = await exec(c, 'f=$(mktemp) && tar -C /workspace --null -T - -h --hard-dereference -czf "$f" && n=$(gzip -dc "$f" | wc -c) && printf "%s\\n" "$n" && base64 -w0 "$f"; s=$?; rm -f "$f"; exit $s', { input: paths.join('\0'), capBytes: 1024 * 1024, timeoutSec: 120 })
    if (pack.truncated) return { result: withTaint(pack, { ok: false, error: 'too large to export (over ~700 KB compressed) — export fewer or smaller files, or write a summary file and export that' }), summary: 'export_to_coordinator: too large' }
    if (pack.exitCode !== 0) return failed('export_to_coordinator', pack)
    const nl = pack.stdout.indexOf('\n')
    const claimed = Number(pack.stdout.slice(0, nl))
    const archive = pack.stdout.slice(nl + 1)
    const { ensureWorkstreamWorkspace } = await import('../../sandbox/store')
    const dest = await ensureWorkstreamWorkspace(child.parentId)
    const tainted = c.tainted || pack.tainted
    // Fix round 1 (M4): the UNCOMPRESSED size must fit the coordinator's remaining quota (and a
    // per-export ceiling) — ~700 KB of gzip can expand far past it.
    const m = workspaceRuntime().manager
    await m.checkQuota(dest.id, { tainted })
    const used = (await dbWorkspaceStore.get(dest.id))?.bytesUsed ?? 0
    const limit = Math.min(EXPORT_MAX_UNPACKED_BYTES, m.settings.quotaBytes - used)
    const tooBig = (n: number) => ({ result: withTaint({ tainted }, { ok: false, error: `too large to export: ${n} bytes uncompressed, and the coordinator's workspace takes at most ${Math.max(0, limit)} more — export less` }), summary: 'export_to_coordinator: too large' })
    if (limit <= 0 || !Number.isFinite(claimed) || claimed > limit) return tooBig(claimed)
    const dir = `/workspace/${EXPORT_DIR}/${child.id}`
    // The archive came from a sandbox the child controls, so the size it claimed is only advisory:
    // INSIDE the coordinator's sandbox the decompression is cut at the limit, and an archive holding
    // anything but plain files and directories (links, devices — its tar could have been swapped) is
    // refused before anything is extracted.
    const unpack = await m.exec(dest.id, exportUnpackCommand(dir, limit), { tainted, signal: ctx.signal, input: archive, timeoutSec: 120 })
    if (unpack.exitCode === 3) return tooBig(limit + 1)
    if (unpack.exitCode !== 0) return failed('export_to_coordinator', { ...unpack, tainted: tainted || unpack.tainted })
    return {
      result: withTaint({ tainted: tainted || unpack.tainted }, { ok: true, copied: paths, to: `${EXPORT_DIR}/${child.id}/`, note: `In your coordinator's workspace under ${EXPORT_DIR}/${child.id}/ — mention the paths in your finish_workstream summary.` }),
      summary: `exported ${paths.length} path${paths.length === 1 ? '' : 's'} to the coordinator`
    }
  })
}

export const workspaceTools: AgentTool[] = [
  readFileTool, writeFileTool, editFileTool, listFilesTool, grepTool, diffTool,
  bashTool, bashOutputTool, killShellTool, deleteFilesTool, watchTool, exportToDocumentTool, importDocumentTool
]
