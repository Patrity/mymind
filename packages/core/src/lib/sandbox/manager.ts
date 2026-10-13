// Cycle 86 (spec §3, D5–D7): the workspace manager — Bridget's workspaces are directories on her own
// Mac and her commands are plain host processes (host/spawn.ts), run as the worker's user (`bridget`)
// with her login environment. It replaces cycle 82's one-Docker-container-per-workspace runtime.
//
//   Clean runs are UNRESTRICTED (D5): the whole filesystem (relative paths resolve inside the
//   workspace dir, absolute ones go anywhere), LAN + internet, any CLI, opted-in secrets — no
//   concurrency cap, no quota. Kept: output caps and foreground timeouts (a tool result stays
//   readable), background shells as process groups, watches, idle / terminal cleanup of processes,
//   the 30-day sweep of finished workstreams' dirs and a low-disk alarm.
//   Taint (cycle 82 persistence, cycle 86 option C): a tainted run's command runs EXACTLY like a
//   clean one — network, secrets, background shells, watches. Taint is bookkeeping only: the first
//   tainted command (or a guard flag on workspace content) marks the workspace, and a result from a
//   tainted workspace carries `tainted`, so the tools mark it `workspaceTainted` and the READING run
//   is tainted too — its outbound tools stay gated by the approval judge (cycles 79b/84). Tony ruled
//   (2026-10-13) to drop the sandbox-exec confinement trial for agent runs.
//   Eval worlds (D7): every command — the world's fixed scripts included — runs under sandbox-exec
//   in the world's own scratch dir, offline, reads under the home dir denied except that dir; every
//   profile path is a realpath (a rule naming a symlink matches nothing); spawn.ts refuses anything
//   else below the manager.
//   Internal (`internal: true`): MyMind's own fixed scripts on a workspace (the Files / Shells UI,
//   shell status / output / kill, export reads) — never model text, never secrets, never counted as
//   use. Their results still carry the taint flag.
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
  /** Ran under sandbox-exec (eval worlds only): offline, writes only in the world's scratch dir. */
  confined?: boolean
}

export interface ExecOptions {
  timeoutSec?: number
  signal?: AbortSignal
  /** Exported secrets (Settings → Secrets → Bridget's shell) — never to an eval world or an internal
   *  script. */
  secrets?: Record<string, string>
  /** The run read untrusted content: the workspace becomes tainted (persistent). The command itself
   *  runs as any other. */
  tainted?: boolean
  /** One of MyMind's own fixed scripts (see the header): never secrets, never counted as use, never
   *  paused by the low-disk alarm. */
  internal?: boolean
  /** Fed to stdin (file contents — never in argv). */
  input?: string
  /** Output cap per stream (tail kept). Default settings.outputCapBytes (64 KB); at most 1 MB. */
  capBytes?: number
  /** Cycle 82's "never start a container" for API-token reads — nothing is ever started on the host,
   *  so it is accepted and ignored. */
  noStart?: boolean
}

/** Hooks the workspace runtime (shells + watches) installs on the shared manager at worker start —
 *  set once, read at call time (no import cycle with the tools). */
export interface SandboxRuntimeHooks {
  /** Armed watches: the workspace is not idle-stopped. */
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
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
  /** An eval world's manager (its schema name): every command confined in the world's scratch dir. */
  evalWorld?: string
  /** Where a command's base env comes from (tests). */
  env?: NodeJS.ProcessEnv
  /** The home dir an eval world's commands may not read (default os.homedir(); realpath'd). */
  home?: string
  log?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => number
  platform?: NodeJS.Platform
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const IDLE_STOP_REASON = 'stopped: the workspace was idle for 15 min (no command, no output read) — background shells are for jobs, not servers'

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

export function createSandboxManager(opts: SandboxManagerOptions = {}) {
  const store = opts.store ?? dbWorkspaceStore
  const s: SandboxSettings = { ...sandboxSettings(), ...opts.settings }
  const evalWorld = opts.evalWorld ?? null
  const log = opts.log ?? console
  const now = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  const fsStats = opts.fsStats ?? defaultFsStats
  const isBusy = (id: string) => (opts.isBusy ?? runtimeHooks.isBusy)?.(id) ?? false
  const onStopped = (id: string, reason: string) => (opts.onStopped ?? runtimeHooks.onStopped)?.(id, reason)
  const refreshShells = (id: string) => (opts.refresh ?? runtimeHooks.refresh)?.(id)
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

  /** Serialise per workspace (in-process): stop decisions. */
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

  /** Persistent taint (cycle 82 I1): the workspace is marked — bookkeeping only (cycle 86 option C):
   *  its results taint whoever reads them; its commands run as before. */
  async function markTainted(id: string): Promise<void> {
    const row = await liveRow(id)
    if (row.tainted) return
    await store.setTainted(id, true)
    log.info(`[workspace] ${id} is now tainted: its results taint the runs that read them`)
  }

  function timeoutOf(sec?: number): number {
    const t = Math.floor(sec ?? s.defaultTimeoutSec)
    if (!Number.isFinite(t) || t < 1) return s.defaultTimeoutSec
    return Math.min(t, s.maxTimeoutSec)
  }

  /** An eval command's tmp dir, inside the world's scratch dir. */
  async function newTmpDir(): Promise<string> {
    return realpath(await mkdtemp(path.join(await ensureEvalRoot(), '.tmp', 'mm-')))
  }

  async function exec(id: string, command: string, o: ExecOptions = {}): Promise<SandboxExecResult> {
    const internal = o.internal === true
    if (!internal) assertDiskOk()
    const timeoutSec = timeoutOf(o.timeoutSec)
    const capBytes = Math.min(MAX_CAP_BYTES, Math.max(1024, Math.floor(o.capBytes ?? s.outputCapBytes)))
    const secrets = o.secrets ?? {}
    for (const k of Object.keys(secrets)) assertSecretName(k)
    if (evalWorld && Object.keys(secrets).length) throw new SandboxUnavailableError('eval: secrets are never available in an eval world')
    const row = await liveRow(id)
    const dir = await ensureDir(id)
    if (o.tainted) await markTainted(id)
    const tainted = o.tainted === true || row.tainted
    let tmp: string | null = null
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1)
    try {
      if (evalWorld && platform !== 'darwin') throw new SandboxUnavailableError(`eval commands must run confined, and that needs macOS sandbox-exec — refused on ${platform}`)
      if (!internal) {
        await store.touch(id)
        if (row.state !== 'running') await store.setContainer(id, null, 'running')
      }
      const base = hostBaseEnv(opts.env)
      let env: Record<string, string>
      let confine: Confinement | undefined
      if (evalWorld) {
        const root = await ensureEvalRoot()
        tmp = await newTmpDir()
        env = { ...confinedEnv(base, tmp), HOME: path.join(root, '.home') }
        // Every path a realpath: an SBPL rule naming a path through a symlink matches nothing.
        confine = { writable: [dir, tmp], denyReadUnder: await realpath(opts.home ?? os.homedir()), readable: [root] }
      } else {
        env = internal ? base : { ...base, ...secrets }
      }
      const r = await runHost({ command, cwd: dir, env, timeoutMs: timeoutSec * 1000, capBytes, signal: o.signal, ...(o.input !== undefined ? { input: o.input } : {}), ...(confine ? { confine, reapGroup: true } : {}) })
      return {
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        oom: false,
        aborted: r.aborted,
        truncated: r.truncated,
        tainted,
        ...(confine ? { confined: true } : {})
      }
    } finally {
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

  /** The worker's boot / 5-minute check: the workspaces dir is writable and, for an eval world's
   *  manager (the only one that confines — option C), sandbox-exec works. Never throws. */
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
    if (evalWorld !== null && platform === 'darwin') {
      const ok = await new Promise<string | null>((resolve) => {
        execFile(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)\n(deny network*)', '/usr/bin/true'], { timeout: 10_000 }, err => resolve(err ? err.message : null))
      })
      if (ok) return { ok: false, reason: `sandbox-exec does not work here (${ok.slice(0, 200)}) — eval-world commands cannot run confined`, checkedAt }
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
    markTainted,
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
