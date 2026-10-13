// Cycle 86 (spec §3, D5–D7): the workspace manager — Bridget's workspaces are directories on her own
// Mac and her commands are plain host processes (host/spawn.ts), run as the worker's user (`bridget`)
// with her login environment. It replaces cycle 82's one-Docker-container-per-workspace runtime.
//
//   Clean runs are UNRESTRICTED (D5): the whole filesystem (relative paths resolve inside the
//   workspace dir, absolute ones go anywhere), LAN + internet, any CLI, opted-in secrets — no
//   concurrency cap, no quota. Kept: output caps and foreground timeouts (a tool result stays
//   readable), background shells as process groups, watches, idle / terminal cleanup of processes,
//   the 30-day sweep of finished workstreams' dirs and a low-disk alarm.
//   Taint confinement (D6, a trial behind ONE switch — agent settings `taintConfinement`, default
//   on): a command of a tainted run, of an `unverified`-only run, or in a workspace that is tainted
//   runs under macOS `sandbox-exec` (host/profile.ts: no network, writes only inside the workspace
//   and a per-command tmp dir), with no secrets; background shells / watches are refused (the tools
//   ask confinementFor first). Every confinement records a `sandbox:confined` activity row and the
//   result carries `confined` (the tool part's chip). Switch off: those commands run unconfined —
//   still without secrets, and taint still marks results (`tainted`) so the reading run is tainted.
//   Taint stays PERSISTENT (cycle 82): the first tainted command flags the workspace; from then on
//   every command there is confined (switch on) until Tony re-enables it (reenableNetwork).
//   Eval worlds (D7): every command — the world's fixed scripts included — runs confined in the
//   world's own scratch dir, offline, reads under the home dir denied except that dir; spawn.ts
//   refuses anything else below the manager.
//   Internal (`internal: true`): MyMind's own fixed scripts on a workspace (the Files / Shells UI,
//   shell status / output / kill, export reads) — never model text, so never confined outside an
//   eval world (a confinement is a taint decision about MODEL commands), never secrets, never counted
//   as use. Their results still carry the taint flag.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertSecretName, confinedEnv, hostBaseEnv } from './host/env'
import { runHost, registerEvalScratch } from './host/spawn'
import { SANDBOX_EXEC, type Confinement } from './host/profile'
import { SandboxDiskLowError, SandboxUnavailableError } from './errors'
import { dbWorkspaceStore, type WorkspaceRow, type WorkspaceStore } from './store'
import type { SandboxHealth } from '../../shared/types/workspaces'
import type { SpanInput } from '../observability/types'
import { currentEvalScope, type EvalScope } from '../eval/context'

export { SandboxStoppedError, SandboxUnavailableError, SandboxDiskLowError } from './errors'
export type { SandboxHealth }

export interface SandboxSettings {
  /** Holds one `<workspaceId>` dir per workspace (Bridget's default working / storage dirs). */
  workspacesDir: string
  /** Holds one `<schema>` dir per eval world (its workspaces, HOME and tmp). */
  evalScratchDir: string
  idleMs: number
  /** Below this much free space new workspace work is paused (and Tony is texted once)… */
  minFreeBytes: number
  /** …until it is back to this (hysteresis). */
  resumeFreeBytes: number
  defaultTimeoutSec: number
  maxTimeoutSec: number
  outputCapBytes: number
}

/** Settings from the worker's env. Prod: `~/mymind/{workspaces,evals-scratch}` (spec §2). */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env): SandboxSettings {
  const prod = env.NODE_ENV === 'production'
  const home = env.HOME || os.homedir()
  return {
    workspacesDir: path.resolve(env.SANDBOX_WORKSPACES_DIR || (prod ? path.join(home, 'mymind', 'workspaces') : '.data/workspaces')),
    evalScratchDir: path.resolve(env.SANDBOX_EVAL_SCRATCH_DIR || (prod ? path.join(home, 'mymind', 'evals-scratch') : '.data/evals-scratch')),
    idleMs: 15 * 60_000,
    minFreeBytes: 5 * 1024 ** 3,
    resumeFreeBytes: 8 * 1024 ** 3,
    defaultTimeoutSec: 120,
    maxTimeoutSec: 600,
    outputCapBytes: 64 * 1024
  }
}

/** Why a command ran under sandbox-exec (the chip and the activity row say which). */
export type ConfinementReason = 'tainted-run' | 'tainted-workspace' | 'unverified' | 'eval'
export interface ConfinementNote { reason: ConfinementReason }

export interface SandboxExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** No memory limit on the host: always false (kept for the tools' result shape). */
  oom: boolean
  aborted: boolean
  truncated: boolean
  /** The run or the workspace is tainted: the content may be mail-derived (the tools mark the
   *  result `workspaceTainted`, which taints the reading run). */
  tainted: boolean
  /** The run is tainted only `unverified` (a guard check that could not run) — not the workspace. */
  offline?: boolean
  /** Ran under sandbox-exec (no network, writes only in the workspace + tmp), and why. */
  confined?: ConfinementNote
}

export interface ExecOptions {
  timeoutSec?: number
  signal?: AbortSignal
  /** Opted-in secrets — never passed to a tainted / unverified run, a tainted workspace, an eval world
   *  or an internal script. */
  secrets?: Record<string, string>
  /** The run read untrusted content: the workspace becomes tainted (persistent) and the command is
   *  confined (switch on). */
  tainted?: boolean
  /** The run is tainted ONLY `unverified`: confined (switch on), no secrets, the workspace NOT marked.
   *  `tainted` wins when both are set. */
  offline?: boolean
  /** One of MyMind's own fixed scripts (see the header): never confined outside an eval world, never
   *  secrets, never counted as use, never paused by the low-disk alarm. */
  internal?: boolean
  /** Fed to stdin (file contents — never in argv). */
  input?: string
  /** Output cap per stream (tail kept). Default settings.outputCapBytes (64 KB); at most 1 MB. */
  capBytes?: number
  /** Cycle 82's "never start a container" for API-token reads — nothing is ever started on the host,
   *  so it is accepted and ignored. */
  noStart?: boolean
  /** Who asked (the `sandbox:confined` activity row). */
  audit?: { runId?: string; tool?: string }
}

/** Hooks the workspace runtime (shells + watches) installs on the shared manager at worker start —
 *  set once, read at call time (no import cycle with the tools). */
export interface SandboxRuntimeHooks {
  /** Armed watches: the workspace is not idle-stopped. */
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
  /** The workspace was just tainted with confinement on: kill its background shells, cancel its
   *  watches (they would keep running with network). */
  onTainted?: (workspaceId: string) => Promise<void> | void
  /** The workspace was stopped (idle, workstream ended, deleted): its background shells die. */
  onStopped?: (workspaceId: string, reason: string) => Promise<void> | void
  /** Every minute, per running workspace: record shells that ended unread. Never counts as use. */
  refresh?: (workspaceId: string) => Promise<void> | void
}
const runtimeHooks: SandboxRuntimeHooks = {}
export function setSandboxRuntimeHooks(h: SandboxRuntimeHooks): void { Object.assign(runtimeHooks, h) }
const MAX_CAP_BYTES = 1024 * 1024

export interface DiskCheckResult {
  freeBytes: number
  low: boolean
  /** This check started a low-disk episode. */
  entered: boolean
  /** This check ended one. */
  recovered: boolean
}

export interface SandboxManagerOptions extends SandboxRuntimeHooks {
  store?: WorkspaceStore
  settings?: Partial<SandboxSettings>
  /** Free bytes on the filesystem holding `dir` (default: statfs). */
  fsStats?: (dir: string) => Promise<{ freeBytes: number }>
  /** agent settings `taintConfinement` (default: the agent settings doc; an unreadable doc → on). */
  taintConfinement?: () => Promise<boolean>
  /** An eval world's manager (its schema name): every command confined in the world's scratch dir. */
  evalWorld?: string
  /** Where a command's base env comes from (tests). */
  env?: NodeJS.ProcessEnv
  /** The activity recorder (default observability/record recordEvent). */
  record?: (e: SpanInput) => void
  log?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => number
  platform?: NodeJS.Platform
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const IDLE_STOP_REASON = 'stopped: the workspace was idle for 15 min (no command, no output read) — background shells are for jobs, not servers'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Re-enable waits at most this × 100ms for aborted tainted runs to return (well under the web's 60s). */
const REENABLE_DRAIN_TRIES = 250

async function defaultFsStats(dir: string): Promise<{ freeBytes: number }> {
  // The dir may not exist yet: walk up to the nearest existing ancestor (same filesystem).
  let d = dir
  for (;;) {
    try {
      const s = await statfs(d)
      return { freeBytes: s.bavail * s.bsize }
    } catch (e) {
      const parent = path.dirname(d)
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === d) throw e
      d = parent
    }
  }
}

/** agent.taintConfinement, read through the cached agent settings doc. Fails closed (on). */
async function defaultTaintConfinement(): Promise<boolean> {
  try {
    const { getAgentSettings } = await import('../agent/agent-settings')
    return (await getAgentSettings()).taintConfinement
  } catch { return true }
}

async function defaultRecord(e: SpanInput): Promise<void> {
  try { (await import('../observability/record')).recordEvent(e) } catch { /* the activity log is best-effort */ }
}

export function createSandboxManager(opts: SandboxManagerOptions = {}) {
  const store = opts.store ?? dbWorkspaceStore
  const s: SandboxSettings = { ...sandboxSettings(), ...opts.settings }
  const evalWorld = opts.evalWorld ?? null
  const log = opts.log ?? console
  const now = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  const fsStats = opts.fsStats ?? defaultFsStats
  const record = opts.record ?? ((e: SpanInput) => { void defaultRecord(e) })
  const isBusy = (id: string) => (opts.isBusy ?? runtimeHooks.isBusy)?.(id) ?? false
  const onStopped = (id: string, reason: string) => (opts.onStopped ?? runtimeHooks.onStopped)?.(id, reason)
  const refreshShells = (id: string) => (opts.refresh ?? runtimeHooks.refresh)?.(id)
  const onTainted = (id: string) => (opts.onTainted ?? runtimeHooks.onTainted)?.(id)
  const confinementOn = async (): Promise<boolean> => {
    try { return await (opts.taintConfinement ?? defaultTaintConfinement)() !== false } catch { return true }
  }
  /** Abort handles of tainted runs in flight, per workspace — registered under the workspace lock by
   *  taint(), so a re-enable (same lock) always sees every one. */
  const taintedInFlight = new Map<string, Set<AbortController>>()
  const locks = new Map<string, Promise<unknown>>()
  /** Commands in flight per workspace — never idle-stopped. */
  const inFlight = new Map<string, number>()
  let lowDisk: { freeBytes: number } | null = null
  /** The eval world's realpath'd root (scratch dir), once created. */
  let evalRoot: string | null = null

  function hostDir(id: string): string {
    if (!UUID.test(id)) throw new Error(`invalid workspace id ${id}`)
    return path.join(s.workspacesDir, id)
  }

  /** Serialise per workspace (in-process): taint / re-enable / stop decisions. */
  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(id, next)
    void next.finally(() => { if (locks.get(id) === next) locks.delete(id) }).catch(() => {})
    return next
  }

  function assertDiskOk(): void {
    if (lowDisk) throw new SandboxDiskLowError(lowDisk.freeBytes, s.minFreeBytes)
  }

  /** An eval world's root (+ its .home and .tmp), created and registered with the spawn guard. */
  async function ensureEvalRoot(): Promise<string> {
    if (evalRoot) return evalRoot
    await mkdir(s.workspacesDir, { recursive: true, mode: 0o700 })
    const root = await realpath(s.workspacesDir)
    await mkdir(path.join(root, '.home'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(root, '.tmp'), { recursive: true, mode: 0o700 })
    registerEvalScratch(evalWorld!, root)
    return evalRoot = root
  }

  /** The workspace dir (0700, the worker's user), created on first use. Returns its realpath. */
  async function ensureDir(id: string): Promise<string> {
    const dir = hostDir(id)
    if (evalWorld) await ensureEvalRoot()
    await mkdir(s.workspacesDir, { recursive: true, mode: 0o700 })
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return realpath(dir)
  }

  async function liveRow(id: string): Promise<WorkspaceRow> {
    const row = await store.get(id)
    if (!row) throw new Error(`workspace ${id} not found`)
    if (row.deletedAt) throw new Error(`workspace ${id} has been deleted`)
    return row
  }

  /**
   * Why a command would be confined, or null. Eval worlds always; otherwise only with the switch on,
   * and only for a MODEL command of a tainted run / in a tainted workspace / of an unverified run.
   */
  async function reasonFor(o: { runTainted: boolean; workspaceTainted: boolean; offline: boolean; internal: boolean }): Promise<ConfinementReason | null> {
    if (evalWorld) return 'eval'
    if (o.internal || (!o.runTainted && !o.workspaceTainted && !o.offline)) return null
    if (!await confinementOn()) return null
    return o.runTainted ? 'tainted-run' : o.workspaceTainted ? 'tainted-workspace' : 'unverified'
  }

  /** For the tools (background shells / watches are refused when a command would be confined). */
  async function confinementFor(id: string, o: { tainted?: boolean; offline?: boolean } = {}): Promise<ConfinementReason | null> {
    const row = await liveRow(id)
    return reasonFor({ runTainted: o.tainted === true, workspaceTainted: row.tainted, offline: o.offline === true, internal: false })
  }

  /** Persistent taint (cycle 82 I1): flag the workspace, register the tainted run (re-enable aborts it). */
  function taint(id: string): Promise<AbortController> {
    return locked(id, async () => {
      const row = await liveRow(id)
      if (!row.tainted) {
        await store.setTainted(id, true)
        log.warn(`[workspace] ${id} is now tainted: its commands are confined until Tony re-enables it`)
      }
      const ctrl = new AbortController()
      let set = taintedInFlight.get(id)
      if (!set) taintedInFlight.set(id, set = new Set())
      set.add(ctrl)
      return ctrl
    })
  }

  function releaseTainted(id: string, ctrl: AbortController): void {
    const set = taintedInFlight.get(id)
    set?.delete(ctrl)
    if (set && !set.size) taintedInFlight.delete(id)
  }

  /** With confinement on, a workspace that just became tainted loses its live background work. */
  async function afterTaint(id: string): Promise<void> {
    if (!evalWorld && !await confinementOn()) return
    try { await onTainted(id) } catch (err) { log.warn(`[workspace] onTainted(${id}) failed:`, (err as Error).message) }
  }

  /** Cycle 84: taint a workspace WITHOUT running a command (the output guard flagged content read
   *  from it) — the same flag flip and the same loss of background work as a tainted command. */
  async function markTainted(id: string): Promise<void> {
    releaseTainted(id, await taint(id))
    await afterTaint(id)
  }

  /**
   * Tony re-enables the workspace: under the workspace lock, abort every tainted run in flight there,
   * wait until each has RETURNED (its process group is dead — runHost kills it on abort), and only
   * then clear the flag. Fails closed (flag kept) when one won't stop. New tainted runs can't
   * register meanwhile: taint() needs this lock.
   */
  function reenableNetwork(id: string): Promise<WorkspaceRow> {
    return locked(id, async () => {
      await liveRow(id)
      for (const ctrl of taintedInFlight.get(id) ?? []) ctrl.abort()
      for (let i = 0; taintedInFlight.get(id)?.size && i < REENABLE_DRAIN_TRIES; i++) await sleep(100)
      if (taintedInFlight.get(id)?.size) throw new SandboxUnavailableError(`tainted command(s) of workspace ${id} did not stop — it stays confined`)
      await store.setTainted(id, false)
      log.info(`[workspace] ${id}: re-enabled by Tony`)
      return liveRow(id)
    })
  }

  function timeoutOf(sec?: number): number {
    const t = Math.floor(sec ?? s.defaultTimeoutSec)
    if (!Number.isFinite(t) || t < 1) return s.defaultTimeoutSec
    return Math.min(t, s.maxTimeoutSec)
  }

  /** A confined command's tmp dir: in the world's scratch for an eval world, else the system tmp. */
  async function newTmpDir(): Promise<string> {
    const base = evalWorld ? path.join(await ensureEvalRoot(), '.tmp') : await realpath(os.tmpdir())
    return realpath(await mkdtemp(path.join(base, 'mm-')))
  }

  async function exec(id: string, command: string, o: ExecOptions = {}): Promise<SandboxExecResult> {
    const internal = o.internal === true
    if (!internal) assertDiskOk()
    const timeoutSec = timeoutOf(o.timeoutSec)
    const capBytes = Math.min(MAX_CAP_BYTES, Math.max(1024, Math.floor(o.capBytes ?? s.outputCapBytes)))
    const secrets = o.secrets ?? {}
    for (const k of Object.keys(secrets)) assertSecretName(k)
    if (evalWorld && Object.keys(secrets).length) throw new SandboxUnavailableError('eval: secrets are never available in an eval world')
    let row = await liveRow(id)
    const dir = await ensureDir(id)
    const ctrl = o.tainted ? await taint(id) : null
    let tmp: string | null = null
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1)
    try {
      if (ctrl) { row = { ...row, tainted: true }; await afterTaint(id) }
      const tainted = o.tainted === true || row.tainted
      const offline = !tainted && o.offline === true
      const reason = await reasonFor({ runTainted: o.tainted === true, workspaceTainted: row.tainted, offline, internal })
      if (reason && platform !== 'darwin') throw new SandboxUnavailableError(`this command must run confined (${reason}), and taint confinement needs macOS sandbox-exec — it is refused on ${platform}`)
      if (!internal) {
        await store.touch(id)
        if (row.state !== 'running') await store.setContainer(id, null, 'running')
      }
      const base = hostBaseEnv(opts.env)
      let env: Record<string, string>
      let confine: Confinement | undefined
      if (reason) {
        tmp = await newTmpDir()
        env = confinedEnv(base, tmp)
        confine = { writable: [dir, tmp] }
        if (evalWorld) {
          const root = await ensureEvalRoot()
          env.HOME = path.join(root, '.home')
          confine = { writable: [dir, tmp], denyReadUnder: os.homedir(), readable: [root] }
        }
        record({ kind: 'tool', name: 'sandbox:confined', severity: 'info', meta: { workspaceId: id, reason, ...(o.audit?.tool ? { tool: o.audit.tool } : {}), ...(o.audit?.runId ? { runId: o.audit.runId } : {}) } })
      } else {
        env = tainted || offline || internal ? base : { ...base, ...secrets }
      }
      const signal = ctrl ? (o.signal ? AbortSignal.any([o.signal, ctrl.signal]) : ctrl.signal) : o.signal
      const r = await runHost({ command, cwd: dir, env, timeoutMs: timeoutSec * 1000, capBytes, signal, ...(o.input !== undefined ? { input: o.input } : {}), ...(confine ? { confine, reapGroup: true } : {}) })
      return {
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        oom: false,
        aborted: r.aborted,
        truncated: r.truncated,
        tainted,
        ...(offline ? { offline: true } : {}),
        ...(reason ? { confined: { reason } } : {})
      }
    } finally {
      if (ctrl) releaseTainted(id, ctrl)
      const n = (inFlight.get(id) ?? 1) - 1
      if (n > 0) inFlight.set(id, n)
      else inFlight.delete(id)
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
      if (!internal) await store.touch(id).catch(() => {})
    }
  }

  /** A fixed housekeeping command (shell status / kill): internal, 30 s. null for a gone workspace. */
  async function peek(id: string, command: string): Promise<SandboxExecResult | null> {
    const row = await store.get(id)
    if (!row || row.deletedAt) return null
    return exec(id, command, { internal: true, timeoutSec: 30 })
  }

  async function stopUnlocked(id: string, reason: string): Promise<void> {
    try { await onStopped(id, reason) } catch (err) { log.warn(`[workspace] onStopped(${id}) failed:`, (err as Error).message) }
    await store.setContainer(id, null, 'stopped')
  }

  /** Stop a workspace's processes (files kept). `reason` goes to its background shells' rows. */
  async function stopWorkspace(id: string, reason = 'stopped: the workspace was stopped'): Promise<void> {
    await locked(id, () => stopUnlocked(id, reason))
  }

  /** Act only if `guard()` still holds UNDER the workspace lock — then run `before` (still under it)
   *  and stop. The workstream teardown: a resume that lands in between keeps everything. */
  async function stopIf(id: string, guard: () => Promise<boolean>, before: () => Promise<void>, reason: string): Promise<boolean> {
    return locked(id, async () => {
      if (!await guard()) return false
      await before()
      await stopUnlocked(id, reason)
      return true
    })
  }

  /** Every minute: workspaces idle for idleMs (no command, no output read, no armed watch) lose their
   *  background shells. Returns the stopped ids. */
  async function idleStop(): Promise<string[]> {
    const stopped: string[] = []
    for (const row of await store.listRunning()) {
      if (now() - row.lastUsedAt.getTime() < s.idleMs || (inFlight.get(row.id) ?? 0) > 0) continue
      try { if (await isBusy(row.id)) continue } catch (err) {
        log.warn(`[workspace] busy check of ${row.id} failed — not stopping it:`, (err as Error).message)
        continue
      }
      try {
        const done = await locked(row.id, async () => {
          const fresh = await store.get(row.id)
          if (!fresh || fresh.state !== 'running' || now() - fresh.lastUsedAt.getTime() < s.idleMs || (inFlight.get(row.id) ?? 0) > 0) return false
          await stopUnlocked(row.id, IDLE_STOP_REASON)
          return true
        })
        if (done) stopped.push(row.id)
      } catch (err) { log.warn(`[workspace] idle stop of ${row.id} failed:`, (err as Error).message) }
    }
    return stopped
  }

  /** Every minute: running workspaces' shells that ended unread are recorded. */
  async function refreshTick(): Promise<void> {
    for (const row of await store.listRunning()) {
      try { await refreshShells(row.id) } catch (err) { log.warn(`[workspace] shell refresh of ${row.id} failed:`, (err as Error).message) }
    }
  }

  /**
   * Low-disk alarm (spec §3), every 5 s: free space on the workspaces volume below minFreeBytes
   * (5 GB) starts an episode — new workspace work is paused (exec refuses with SandboxDiskLowError;
   * running work is left alone) and the caller texts Tony once — until it is back to resumeFreeBytes
   * (8 GB).
   */
  async function diskCheck(): Promise<DiskCheckResult> {
    const { freeBytes } = await fsStats(s.workspacesDir)
    if (lowDisk) {
      if (freeBytes >= s.resumeFreeBytes) {
        lowDisk = null
        log.info(`[workspace] disk recovered (${freeBytes} bytes free) — workspace work resumes`)
        return { freeBytes, low: false, entered: false, recovered: true }
      }
      lowDisk = { freeBytes }
      return { freeBytes, low: true, entered: false, recovered: false }
    }
    if (freeBytes >= s.minFreeBytes) return { freeBytes, low: false, entered: false, recovered: false }
    lowDisk = { freeBytes }
    log.error(`[workspace] LOW DISK: ${freeBytes} bytes free under ${s.workspacesDir} — new workspace work is paused`)
    return { freeBytes, low: true, entered: true, recovered: false }
  }

  /** Remove a workspace's processes, files and row (the 30-day sweep). */
  async function destroyWorkspace(id: string): Promise<void> {
    await locked(id, async () => {
      try { await onStopped(id, 'stopped: the workspace was deleted') } catch (err) { log.warn(`[workspace] onStopped(${id}) failed:`, (err as Error).message) }
      // fs.rm unlinks symlinks, never follows them.
      await rm(hostDir(id), { recursive: true, force: true })
      await store.remove(id)
    })
  }

  /** Daily: start the 30-day clock for workspaces of deleted workstreams; destroy expired ones —
   *  deleted 30 days ago, or their workstream finished 30 days ago. */
  async function sweep(retentionMs = 30 * 24 * 60 * 60_000): Promise<string[]> {
    await store.stampOrphans()
    const gone: string[] = []
    for (const row of await store.listExpired(new Date(now() - retentionMs))) {
      try { await destroyWorkspace(row.id); gone.push(row.id) } catch (err) { log.warn(`[workspace] sweep of ${row.id} failed:`, (err as Error).message) }
    }
    return gone
  }

  /** The worker's boot / 5-minute check: the workspaces dir is writable and (macOS) sandbox-exec
   *  works. Never throws. */
  async function health(): Promise<SandboxHealth> {
    const checkedAt = new Date(now()).toISOString()
    if (lowDisk) return { ok: false, reason: `the Mac is low on disk (${(lowDisk.freeBytes / 1024 ** 3).toFixed(1)} GB free) — new workspace work is paused until space is freed`, checkedAt }
    try {
      await mkdir(s.workspacesDir, { recursive: true, mode: 0o700 })
      const probe = await mkdtemp(path.join(s.workspacesDir, '.probe-'))
      await rm(probe, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, reason: `the workspaces dir ${s.workspacesDir} is not writable (${(err as Error).message})`, checkedAt }
    }
    if (platform === 'darwin') {
      const ok = await new Promise<string | null>((resolve) => {
        execFile(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)\n(deny network*)', '/usr/bin/true'], { timeout: 10_000 }, err => resolve(err ? err.message : null))
      })
      if (ok) return { ok: false, reason: `sandbox-exec does not work here (${ok.slice(0, 200)}) — tainted commands are refused while taint confinement is on`, checkedAt }
    }
    return { ok: true, checkedAt }
  }

  return {
    settings: s,
    /** The eval world this manager belongs to (null: Tony's). */
    evalWorld,
    /** An eval world's manager: every command offline (confined). */
    offline: evalWorld !== null,
    hostDir,
    ensureDir,
    exec,
    peek,
    confinementFor,
    markTainted,
    reenableNetwork,
    stopWorkspace,
    stopIf,
    idleStop,
    refreshTick,
    diskCheck,
    isDiskLow: () => lowDisk !== null,
    destroyWorkspace,
    sweep,
    health,
    /** Commands in flight (tests). */
    load: () => ({ inFlight: [...inFlight.entries()] })
  }
}

export type SandboxManager = ReturnType<typeof createSandboxManager>

let shared: SandboxManager | null = null
const evalManagers = new WeakMap<EvalScope, SandboxManager>()
/** Each eval world's manager calls ITS runtime's hooks (its shells / watches), never Tony's global
 *  ones. runtime.ts registers them per scope. */
const evalHooks = new WeakMap<object, SandboxRuntimeHooks>()
export function setEvalSandboxHooks(scope: object, hooks: SandboxRuntimeHooks): void { evalHooks.set(scope, hooks) }
/** Tests: the hooks registered for a world. */
export function _evalSandboxHooksFor(scope: object): SandboxRuntimeHooks | undefined { return evalHooks.get(scope) }

/** The worker's manager — or, inside an eval world, that world's own confined manager (cycle 85):
 *  Tony's manager is never reachable from a world. */
export function sandboxManager(): SandboxManager {
  const scope = currentEvalScope()
  if (scope) {
    let m = evalManagers.get(scope)
    if (!m) evalManagers.set(scope, m = createEvalSandboxManager(scope))
    return m
  }
  return shared ??= createSandboxManager()
}

/** An eval world's scratch dir (its workspaces, HOME and tmp; removed by cleanupEvalRun / the boot sweep). */
export function evalScratchDir(worldId: string, base = sandboxSettings().evalScratchDir): string {
  return path.join(base, worldId)
}

/** An eval world's manager: every command confined to its own scratch dir, offline, no secrets. */
export function createEvalSandboxManager(scope: Pick<EvalScope, 'runId' | 'worldId'>, opts: SandboxManagerOptions = {}): SandboxManager {
  const h = () => evalHooks.get(scope) ?? {}
  return createSandboxManager({
    isBusy: id => h().isBusy?.(id) ?? false,
    onStopped: (id, reason) => h().onStopped?.(id, reason),
    refresh: id => h().refresh?.(id),
    onTainted: id => h().onTainted?.(id),
    ...opts,
    evalWorld: scope.worldId,
    settings: { ...opts.settings, workspacesDir: evalScratchDir(scope.worldId, opts.settings?.evalScratchDir) }
  })
}

export interface HousekeepingOptions {
  tickMs?: number
  sweepMs?: number
  /** The low-disk alarm interval (5 s). */
  diskMs?: number
  /** Once per low-disk episode (activity_log + a text to Tony — main.ts). */
  onLowDisk?: (r: DiskCheckResult) => Promise<void> | void
  /** Once, at start (re-attach background shells, re-arm watches). */
  afterReconcile?: () => Promise<void> | void
  /** Every minute, before the idle stop (tear down finished workstreams' workspaces). */
  onTick?: () => Promise<void> | void
  /** The workspace runtime's health — at boot and then every healthMs (default 5 min). The worker
   *  puts it on its heartbeat. */
  onHealth?: (h: SandboxHealth) => void
  healthMs?: number
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

/**
 * Worker housekeeping (spec §3): at start re-attach shells / re-arm watches, then every minute the
 * finished-workstream teardown, the shell refresh and the idle stop, the deletion sweep daily, and
 * the low-disk alarm every 5 s. Never throws.
 */
export function startSandboxHousekeeping(m: SandboxManager = sandboxManager(), o: HousekeepingOptions = {}): () => void {
  const log = o.log ?? console
  let stopped = false
  let started = false
  let lastSweep = 0
  let running: Promise<void> | null = null
  let diskRunning = false
  let lastHealth = 0
  let lastReason: string | null | undefined
  const report = (h: SandboxHealth) => {
    const reason = h.ok ? null : h.reason
    if (reason !== lastReason) log[h.ok ? 'info' : 'warn'](h.ok ? '[workspace] host runtime ok' : `[workspace] unavailable: ${reason}`)
    lastReason = reason
    try { o.onHealth?.(h) } catch (err) { log.warn('[workspace] health report failed:', (err as Error).message) }
  }
  const step = async () => {
    if (!started) {
      started = true
      await o.afterReconcile?.()
    }
    if (Date.now() - lastHealth >= (o.healthMs ?? 5 * 60_000)) {
      lastHealth = Date.now()
      report(await m.health())
    }
    if (stopped) return
    try { await o.onTick?.() } catch (err) { log.warn('[workspace] tick hook failed:', (err as Error).message) }
    if (stopped) return
    await m.refreshTick()
    if (stopped) return
    await m.idleStop()
    if (stopped) return
    if (Date.now() - lastSweep >= (o.sweepMs ?? 24 * 60 * 60_000)) {
      lastSweep = Date.now()
      const gone = await m.sweep()
      if (gone.length) log.info(`[workspace] swept ${gone.length} deleted workspace(s)`)
    }
  }
  const tick = () => {
    if (stopped || running) return
    running = step().catch(err => log.error('[workspace] housekeeping failed:', err)).finally(() => { running = null })
  }
  const disk = () => {
    if (stopped || diskRunning) return
    diskRunning = true
    m.diskCheck()
      .then(async (r) => { if (r.entered) await o.onLowDisk?.(r) })
      .catch(err => log.error('[workspace] disk alarm failed:', err))
      .finally(() => { diskRunning = false })
  }
  disk()
  tick()
  const timer = setInterval(tick, o.tickMs ?? 60_000)
  const diskTimer = setInterval(disk, o.diskMs ?? 5_000)
  timer.unref?.()
  diskTimer.unref?.()
  return () => { stopped = true; clearInterval(timer); clearInterval(diskTimer) }
}
