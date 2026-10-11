// Cycle 82 (spec §2): the sandbox manager — one Docker container per workspace, worker-side only.
//
//   ensureContainer(id) → create/start `mymind-ws-<id>` (label mymind.workspace=<id>); exactly one
//                         even under concurrency (in-process lock + docker's unique container name);
//                         recreated (files kept) when its image or isolation-flags hash is stale.
//   exec(id, cmd)       → `docker exec` (timeout default 120s / max 600s, 64 KB tail-kept output,
//                         env HOME/PATH/LANG + opted-in secrets).
//   Taint (review I1 ruling — PERSISTENT): the first tainted command in a workspace kills its
//   networked container (every process in it, background ones included) and sets
//   `workspaces.tainted`. From then on EVERY command there — tainted or not — runs in a one-off
//   `docker run --rm --network none` (same mount + limits, no secrets) until Tony re-enables the
//   network (POST /api/workspaces/:id/reenable-network). The networked container is never started
//   while the flag is set (checked under the per-workspace lock).
//   Disk (review I2): RLIMIT_FSIZE 1 GiB per process (docker.ts); bytes + files quota; and a 5s
//   free-space watchdog (diskCheck) that stops every sandbox when the host disk runs low.
//   idleStop / quotaTick / reconcile / sweep / diskCheck — the worker's housekeeping.
//
// Path safety: the host only ever creates/removes `<workspacesDir>/<uuid>`; everything that reads or
// writes workspace FILES runs inside a container, so a symlink in the workspace can't reach the host.
// Preflight fails closed: no Docker / no image / firewall required but not matching network.ts →
// a SandboxUnavailableError the workspace tools surface as-is.
import { execFile } from 'node:child_process'
import { chown, mkdir, rmdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LABEL_FLAGS, LABEL_TAINTED, LABEL_TEST, LABEL_WORKSPACE, SANDBOX_UID, SandboxUnavailableError,
  assertSecretName, createArgs, createDockerCli, dockerAvailable, ensureNetwork, execArgs, flagsHash, killExecArgs,
  parseExecStatus, taintedRunArgs, verifyNetworkIsolation,
  type DockerResult, type DockerRunner, type ExecStatus
} from './docker'
import { DEFAULT_SANDBOX_DNS } from './network'
import { DEFAULT_QUOTA_BYTES, DEFAULT_QUOTA_INODES, MEASURE_COMMAND, MEASURE_TIMEOUT_SEC, SandboxDiskLowError, SandboxQuotaError, overQuota, parseDu } from './quota'
import { dbWorkspaceStore, type WorkspaceRow, type WorkspaceStore } from './store'
import { coreConfig } from '../../config'
import { sandboxRequireFirewall } from '../../config-env'

export { SandboxUnavailableError } from './docker'
export { SandboxQuotaError, SandboxDiskLowError } from './quota'

export interface SandboxSettings {
  image: string
  workspacesDir: string
  /** Resolvers for the sandbox network ([] = Docker's default). */
  dns: string[]
  /** 'enforce': refuse to run unless the live iptables rules match network.ts. */
  firewall: 'enforce' | 'off'
  idleMs: number
  quotaBytes: number
  quotaInodes: number
  /** Below this much free space on the workspaces filesystem every sandbox is stopped. */
  minFreeBytes: number
  /** …and commands are refused until it is back above this (hysteresis). */
  resumeFreeBytes: number
  /** Inode floor (rereview #1): low when free inodes < max(minFreeInodes, minFreeInodesRatio × total). */
  minFreeInodes: number
  minFreeInodesRatio: number
  /** Resume when free inodes ≥ max(resumeFreeInodes, resumeFreeInodesRatio × total). */
  resumeFreeInodes: number
  resumeFreeInodesRatio: number
  defaultTimeoutSec: number
  maxTimeoutSec: number
  outputCapBytes: number
}

function firewallRequired(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  // CoreConfig is the source of truth (review M1); before initCore (scripts/tests) map the env.
  try { return coreConfig().sandboxRequireFirewall } catch { return sandboxRequireFirewall(env, platform) }
}

/** Settings from the worker's env. The firewall gate is CoreConfig.sandboxRequireFirewall. */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, requireFirewall = firewallRequired(env, platform)): SandboxSettings {
  const prod = env.NODE_ENV === 'production'
  const linux = platform === 'linux'
  return {
    image: env.SANDBOX_IMAGE || 'mymind-sandbox:current',
    workspacesDir: path.resolve(env.SANDBOX_WORKSPACES_DIR || (prod ? '/opt/mymind/.workspaces' : '.data/workspaces')),
    // Docker Desktop drops outbound UDP to public resolvers, so dev on macOS keeps Docker's own.
    dns: env.SANDBOX_DNS !== undefined ? env.SANDBOX_DNS.split(',').map(s => s.trim()).filter(Boolean) : linux ? [...DEFAULT_SANDBOX_DNS] : [],
    firewall: requireFirewall ? 'enforce' : 'off',
    idleMs: 15 * 60_000,
    quotaBytes: DEFAULT_QUOTA_BYTES,
    quotaInodes: DEFAULT_QUOTA_INODES,
    minFreeBytes: 4 * 1024 ** 3,
    resumeFreeBytes: 5 * 1024 ** 3,
    minFreeInodes: 200_000,
    minFreeInodesRatio: 0.05,
    resumeFreeInodes: 250_000,
    resumeFreeInodesRatio: 0.07,
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
  /** Killed by the 2 GB memory limit (review M10) — not a timeout. */
  oom: boolean
  aborted: boolean
  truncated: boolean
  /** Ran with no network and no secrets (the run or the workspace is tainted). */
  tainted: boolean
}

export interface ExecOptions {
  timeoutSec?: number
  signal?: AbortSignal
  /** Opted-in sandbox secrets (spec §6) — never passed to tainted runs / tainted workspaces. */
  secrets?: Record<string, string>
  /** The run has read untrusted content: no network (spec D5) — and the workspace becomes tainted. */
  tainted?: boolean
  /** Fed to the command's stdin (file contents — never in argv: 128 KB cap and visible in /proc). */
  input?: string
  /** Output cap per stream (tail kept). Default settings.outputCapBytes (64 KB); at most 1 MB. */
  capBytes?: number
}

/** Hooks the workspace runtime (Task 2: background shells + watches) installs on the shared
 *  manager at worker start — set once, read at call time (no import cycle with the tools). */
export interface SandboxRuntimeHooks {
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
  onOverQuota?: (workspaceId: string, usage: { bytes: number; inodes: number }) => Promise<void> | void
}
const runtimeHooks: SandboxRuntimeHooks = {}
export function setSandboxRuntimeHooks(h: SandboxRuntimeHooks): void { Object.assign(runtimeHooks, h) }
const MAX_CAP_BYTES = 1024 * 1024

export interface FsStats {
  freeBytes: number
  freeInodes: number
  /** 0 when the filesystem has no fixed inode table (ZFS, btrfs): the inode floor is skipped. */
  totalInodes: number
}

export interface DiskCheckResult {
  freeBytes: number
  freeInodes: number
  /** What tripped the episode: 'bytes' | 'inodes' (null when not low). */
  reason: 'bytes' | 'inodes' | null
  low: boolean
  /** This check started a low-disk episode (containers were stopped). */
  entered: boolean
  /** This check ended one. */
  recovered: boolean
  stopped: string[]
}

export interface SandboxManagerOptions {
  docker?: DockerRunner
  store?: WorkspaceStore
  settings?: Partial<SandboxSettings>
  /** Labels stamped on every container this manager creates AND the reconcile/kill scope (tests). */
  labels?: Record<string, string>
  /** `iptables -S` on the host (firewall verification). */
  iptablesS?: () => Promise<string>
  /** Free bytes + inodes on the filesystem holding `dir` (default: statfs). */
  fsStats?: (dir: string) => Promise<FsStats>
  /** True while a workspace must not be idle-stopped (background shells / armed watches — Task 2). */
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
  /** Called when a workspace is over quota or stopped by the low-disk watchdog (Task 2 kills its
   *  background shells). */
  onOverQuota?: (workspaceId: string, usage: { bytes: number; inodes: number }) => Promise<void> | void
  log?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => number
  uid?: number | undefined
  platform?: NodeJS.Platform
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREFLIGHT_TTL_MS = 60_000

export function containerName(workspaceId: string): string {
  return `mymind-ws-${workspaceId}`
}

/** Thrown inside the lock when a tainted workspace would get its networked container. */
class WorkspaceTaintedError extends Error {}

interface Inspected {
  Id: string
  Name: string
  Image: string
  State: { Running: boolean }
  Config: { Labels: Record<string, string> | null }
}

function defaultIptablesS(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('iptables', ['-S'], { timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
  })
}

async function defaultFsStats(dir: string): Promise<FsStats> {
  // The workspaces dir may not exist yet: walk up to the nearest existing ancestor (same filesystem).
  let d = dir
  for (;;) {
    try {
      const s = await statfs(d)
      return { freeBytes: s.bavail * s.bsize, freeInodes: s.ffree, totalInodes: s.files }
    } catch (e) {
      const parent = path.dirname(d)
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === d) throw e
      d = parent
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Re-enable waits at most this × 100ms for aborted tainted runs to return (well under the web's 60s). */
const REENABLE_DRAIN_TRIES = 250

export function createSandboxManager(opts: SandboxManagerOptions = {}) {
  const docker = opts.docker ?? createDockerCli()
  const store = opts.store ?? dbWorkspaceStore
  const s: SandboxSettings = { ...sandboxSettings(), ...opts.settings }
  const labels = opts.labels ?? {}
  const log = opts.log ?? console
  const now = opts.now ?? Date.now
  const uid = 'uid' in opts ? opts.uid : process.getuid?.()
  const platform = opts.platform ?? process.platform
  const fsStats = opts.fsStats ?? defaultFsStats
  const isBusy = (id: string) => (opts.isBusy ?? runtimeHooks.isBusy)?.(id) ?? false
  const onOverQuota = (id: string, usage: { bytes: number; inodes: number }) => (opts.onOverQuota ?? runtimeHooks.onOverQuota)?.(id, usage)
  /** Abort handles of tainted one-offs in flight, per workspace — registered under the workspace
   *  lock by `taint()`, so a re-enable (same lock) always sees every one (rereview #5). */
  const taintedInFlight = new Map<string, Set<AbortController>>()
  const quota = { bytes: s.quotaBytes, inodes: s.quotaInodes }
  const locks = new Map<string, Promise<unknown>>()
  const measuredAt = new Map<string, number>()
  let preflightOk: { at: number; network: boolean } | null = null
  let imageId: string | null = null
  let lowDisk: { freeBytes: number; freeInodes: number; reason: 'bytes' | 'inodes' } | null = null

  function hostDir(id: string): string {
    if (!UUID.test(id)) throw new Error(`invalid workspace id ${id}`)
    const dir = path.join(s.workspacesDir, id)
    if (dir.includes(',')) throw new Error('workspaces dir must not contain a comma (docker --mount syntax)')
    return dir
  }

  /** Serialise per workspace (in-process). */
  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(id, next)
    void next.finally(() => { if (locks.get(id) === next) locks.delete(id) }).catch(() => {})
    return next
  }

  function assertDiskOk(): void {
    if (lowDisk) throw new SandboxDiskLowError(lowDisk.freeBytes, s.minFreeBytes, lowDisk.reason === 'inodes' ? lowDisk.freeInodes : undefined)
  }

  async function preflight(needNetwork: boolean): Promise<void> {
    if (preflightOk && now() - preflightOk.at < PREFLIGHT_TTL_MS && (preflightOk.network || !needNetwork)) return
    if (!await dockerAvailable(docker)) throw new SandboxUnavailableError('the workspace sandbox is unavailable: Docker is not running on this host')
    const img = await docker(['image', 'inspect', '--format', '{{.Id}}', s.image], { timeoutMs: 15_000 })
    if (img.code !== 0) throw new SandboxUnavailableError(`the workspace sandbox is unavailable: image ${s.image} is missing (build it with deploy/sandbox/build-image.sh)`)
    imageId = img.stdout.trim()
    if (needNetwork) {
      await ensureNetwork(docker)
      if (s.firewall === 'enforce') {
        const check = await verifyNetworkIsolation(docker, opts.iptablesS ?? defaultIptablesS)
        if (!check.ok) {
          log.error('[sandbox] network isolation check failed:', check.problems.join('; '))
          throw new SandboxUnavailableError(`the workspace sandbox is unavailable: its network firewall is not in place (${check.problems[0]}) — run deploy/sandbox/install-network.sh`)
        }
      }
    }
    preflightOk = { at: now(), network: needNetwork || (preflightOk?.network ?? false) }
  }

  /** Create the host dir (0700) owned by the sandbox user. Only the dir itself — never its contents. */
  async function ensureDir(id: string): Promise<string> {
    const dir = hostDir(id)
    await mkdir(s.workspacesDir, { recursive: true, mode: 0o711 })
    let created = false
    try { await mkdir(dir, { mode: 0o700 }); created = true } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    if (!created) return dir
    if (uid === 0) await chown(dir, SANDBOX_UID, SANDBOX_UID)
    else if (platform === 'linux') {
      // Non-root Linux dev: a throwaway root container with ONLY CAP_CHOWN hands the dir to 10001.
      const r = await docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--user', '0:0',
        '--security-opt', 'no-new-privileges', ...labelArgs(id), '--mount', `type=bind,src=${dir},dst=/workspace`,
        s.image, 'chown', `${SANDBOX_UID}:${SANDBOX_UID}`, '/workspace'], { timeoutMs: 60_000 })
      if (r.code !== 0) throw new SandboxUnavailableError(`could not hand the workspace dir to uid ${SANDBOX_UID}: ${r.stderr.trim()}`)
    }
    // macOS (Docker Desktop): bind mounts ignore host ownership — uid 10001 can write as is.
    return dir
  }

  function labelArgs(id: string): string[] {
    return Object.entries({ [LABEL_WORKSPACE]: id, ...labels }).flatMap(([k, v]) => ['--label', `${k}=${v}`])
  }

  function containerSpec(id: string) {
    return { name: containerName(id), image: s.image, workspaceId: id, hostDir: hostDir(id), labels, dns: s.dns }
  }

  async function inspect(nameOrId: string): Promise<Inspected | null> {
    const r = await docker(['container', 'inspect', nameOrId], { timeoutMs: 15_000 })
    if (r.code !== 0) return null
    const arr = JSON.parse(r.stdout) as Inspected[]
    return arr[0] ?? null
  }

  async function liveRow(id: string): Promise<WorkspaceRow> {
    const row = await store.get(id)
    if (!row) throw new Error(`workspace ${id} not found`)
    if (row.deletedAt) throw new Error(`workspace ${id} has been deleted`)
    return row
  }

  async function ensureContainerUnlocked(id: string): Promise<{ containerId: string; name: string }> {
    assertDiskOk()
    const row = await liveRow(id)
    // Re-read under the lock: a taint that just landed must never be raced by a networked start.
    if (row.tainted) throw new WorkspaceTaintedError(`workspace ${id} is tainted`)
    await preflight(true)
    const name = containerName(id)
    const wantFlags = flagsHash(containerSpec(id))
    for (let attempt = 0; attempt < 3; attempt++) {
      let c = await inspect(name)
      if (c && ((imageId && c.Image !== imageId) || c.Config.Labels?.[LABEL_FLAGS] !== wantFlags)) {
        log.info(`[sandbox] workspace ${id}: container built from an older image or isolation policy — recreating (files kept)`)
        await docker(['rm', '-f', c.Id], { timeoutMs: 30_000 })
        c = null
      }
      if (!c) {
        await ensureDir(id)
        const r = await docker(createArgs(containerSpec(id)), { timeoutMs: 60_000 })
        if (r.code !== 0) {
          if (/already in use|Conflict/i.test(r.stderr)) continue // another process created it — use theirs
          throw new SandboxUnavailableError(`could not create the workspace sandbox: ${r.stderr.trim()}`)
        }
        c = await inspect(name)
        if (!c) continue
      }
      if (!c.State.Running) {
        const st = await docker(['start', c.Id], { timeoutMs: 60_000 })
        if (st.code !== 0 && !/already running|is running/i.test(st.stderr)) throw new SandboxUnavailableError(`could not start the workspace sandbox: ${st.stderr.trim()}`)
      }
      await store.setContainer(id, c.Id, 'running')
      return { containerId: c.Id, name }
    }
    throw new SandboxUnavailableError(`could not create the workspace sandbox for ${id} (name conflict kept recurring)`)
  }

  function ensureContainer(id: string) {
    return locked(id, () => ensureContainerUnlocked(id))
  }

  /**
   * Taint the workspace (review I1): flag first (so nothing networked can start), then kill the
   * networked container — every process in it dies, background ones included. Fails closed: if the
   * container can't be stopped, the tainted command does not run.
   */
  function taint(id: string): Promise<AbortController> {
    return locked(id, async () => {
      const row = await liveRow(id)
      if (!row.tainted) {
        await store.setTainted(id, true)
        log.warn(`[sandbox] workspace ${id} is now tainted: no network and no secrets until re-enabled`)
      }
      const c = await inspect(containerName(id))
      if (c?.State.Running) {
        const k = await docker(['kill', c.Id], { timeoutMs: 30_000 })
        if (k.code !== 0 && (await inspect(c.Id))?.State.Running) throw new SandboxUnavailableError(`could not stop the networked sandbox of ${id} before a tainted command: ${k.stderr.trim()}`)
      }
      if (c || row.state !== 'stopped') await store.setContainer(id, c?.Id ?? null, 'stopped')
      // Register the tainted run while still holding the lock (see taintedInFlight).
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

  /**
   * Tony re-enables the network (rereview #5): under the workspace lock, abort every tainted run in
   * flight and kill every tainted one-off container of the workspace, wait until none is left, and
   * only THEN clear the flag — so no tainted write can land after the workspace is trusted again.
   * Fails closed (flag kept) when a tainted container won't go away.
   */
  function reenableNetwork(id: string): Promise<WorkspaceRow> {
    return locked(id, async () => {
      await liveRow(id)
      for (const ctrl of taintedInFlight.get(id) ?? []) ctrl.abort()
      // Carry-over (rereview minor 1): wait until every aborted tainted run has RETURNED. A run
      // returns only once its one-off container has exited (execOneOff keeps killing it until the
      // `docker run` CLI comes back), so an abort that raced the container's creation can no
      // longer slip a tainted command past the listing below. New tainted runs can't register
      // meanwhile: taint() needs this lock.
      for (let i = 0; taintedInFlight.get(id)?.size && i < REENABLE_DRAIN_TRIES; i++) await sleep(100)
      if (taintedInFlight.get(id)?.size) throw new SandboxUnavailableError(`tainted command(s) of workspace ${id} did not stop — its network stays off`)
      const tainted = async () => (await listLabelled()).filter(c => inScope(c) && c.Config.Labels?.[LABEL_WORKSPACE] === id && c.Config.Labels?.[LABEL_TAINTED] !== undefined)
      for (let i = 0; i < 40; i++) {
        const left = await tainted()
        if (!left.length) break
        for (const c of left) await docker(['rm', '-f', c.Id], { timeoutMs: 30_000 })
        await sleep(250)
      }
      const still = await tainted()
      if (still.length) throw new SandboxUnavailableError(`could not stop ${still.length} tainted command(s) of workspace ${id} — its network stays off`)
      await store.setTainted(id, false)
      const row = await liveRow(id)
      log.info(`[sandbox] workspace ${id}: network re-enabled by Tony`)
      return row
    })
  }

  function timeoutOf(sec?: number): number {
    const t = Math.floor(sec ?? s.defaultTimeoutSec)
    if (!Number.isFinite(t) || t < 1) return s.defaultTimeoutSec
    return Math.min(t, s.maxTimeoutSec)
  }

  function result(r: DockerResult, tainted: boolean, aborted: boolean): SandboxExecResult {
    const { stderr, status } = parseExecStatus(r.stderr)
    const st: ExecStatus | null = status
    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr,
      timedOut: r.timedOut || st === 'timeout',
      oom: st === 'oom',
      aborted: aborted || r.aborted || st === 'aborted',
      truncated: r.truncated,
      tainted
    }
  }

  /**
   * Kill an exec's process group. killExecArgs drops a tombstone first, so a wrapper that starts
   * after this still kills itself (review M5). When the kill itself can't run (the container is at
   * its pids limit) and the wrapper has not exited, the container is restarted — under the workspace
   * lock and ONLY when the workspace is not tainted (rereview #2: a tainted workspace's networked
   * container must never start); a tainted one is just killed.
   */
  async function hardKill(id: string, name: string, execId: string, wrapperExited: () => boolean): Promise<void> {
    const k = await docker(killExecArgs(name, execId), { timeoutMs: 15_000 })
    if (k.code === 0 || wrapperExited()) return
    await locked(id, async () => {
      const row = await store.get(id)
      if (!row || row.tainted || row.deletedAt) {
        log.warn(`[sandbox] could not kill exec ${execId} in ${name} (${k.stderr.trim()}) — killing the container (workspace tainted or gone)`)
        await docker(['kill', name], { timeoutMs: 30_000 })
        if (row) await store.setContainer(id, row.containerId, 'stopped')
        return
      }
      if (lowDisk) {
        // Carry-over (rereview minor 3): never START a container during a low-disk episode.
        log.warn(`[sandbox] could not kill exec ${execId} in ${name} (${k.stderr.trim()}) — killing the container (low disk)`)
        await docker(['kill', name], { timeoutMs: 30_000 })
        await store.setContainer(id, row.containerId, 'stopped')
        return
      }
      log.warn(`[sandbox] could not kill exec ${execId} in ${name} (${k.stderr.trim()}) — restarting the container`)
      await docker(['restart', '-t', '0', name], { timeoutMs: 60_000 })
    })
  }

  function newExecId(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  }

  /** A command in a one-off `--network none` container (tainted run or tainted workspace). */
  async function execOneOff(id: string, command: string, timeoutSec: number, signal?: AbortSignal, io: { input?: string; capBytes?: number } = {}): Promise<DockerResult & { abortedHere: boolean }> {
    await preflight(false)
    await ensureDir(id)
    const execId = newExecId()
    const name = `mymind-wst-${id.slice(0, 8)}-${execId}`
    let aborted = false
    let returned = false
    // An abort keeps killing the one-off until the attached `docker run` returns — i.e. until the
    // container has EXITED (rereview minor 1: one kill that ran before the container existed used
    // to be the only one). The CLI itself is never killed on abort, so its return proves the exit.
    const onAbort = () => {
      aborted = true
      void (async () => {
        while (!returned) {
          await docker(['kill', name], { timeoutMs: 15_000 })
          if (!returned) await sleep(250)
        }
      })()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false, abortedHere: true }
      const r = await docker(taintedRunArgs({ ...containerSpec(id), name, command, execId, timeoutSec }),
        { timeoutMs: (timeoutSec + 15) * 1000, capBytes: io.capBytes ?? s.outputCapBytes, ...(io.input !== undefined ? { input: io.input } : {}) })
      if (r.timedOut) await docker(['rm', '-f', name], { timeoutMs: 15_000 })
      return { ...r, abortedHere: aborted }
    } finally {
      returned = true
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function exec(id: string, command: string, o: ExecOptions = {}): Promise<SandboxExecResult> {
    assertDiskOk()
    const timeoutSec = timeoutOf(o.timeoutSec)
    const capBytes = Math.min(MAX_CAP_BYTES, Math.max(1024, Math.floor(o.capBytes ?? s.outputCapBytes)))
    const io = { capBytes, ...(o.input !== undefined ? { input: o.input } : {}) }
    const secrets = o.secrets ?? {}
    for (const k of Object.keys(secrets)) assertSecretName(k)
    const row = await liveRow(id)
    const runTainted = async () => {
      const ctrl = await taint(id)
      try {
        await store.touch(id)
        const signal = o.signal ? AbortSignal.any([o.signal, ctrl.signal]) : ctrl.signal
        const r = await execOneOff(id, command, timeoutSec, signal, io)
        return result(r, true, r.abortedHere)
      } finally { releaseTainted(id, ctrl) }
    }
    if (o.tainted || row.tainted) return runTainted()

    let name: string
    try { ({ name } = await ensureContainer(id)) } catch (e) {
      if (e instanceof WorkspaceTaintedError) return runTainted()
      throw e
    }
    await store.touch(id)
    const execId = newExecId()
    let aborted = false
    // True once the WRAPPER has exited on its own (the CLI returned without being aborted) — not
    // when an abort merely killed the CLI client (rereview #4).
    let wrapperExited = false
    const onAbort = () => { aborted = true; void hardKill(id, name, execId, () => wrapperExited) }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (o.signal?.aborted) return result({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }, false, true)
      // The signal also kills the CLI client at once (review M5); the in-container group is killed
      // by hardKill above (tombstone first, so an abort before the wrapper starts still lands).
      const r = await docker(execArgs({ container: name, command, execId, timeoutSec, secretNames: Object.keys(secrets) }),
        { timeoutMs: (timeoutSec + 15) * 1000, env: secrets, capBytes, signal: o.signal, ...(o.input !== undefined ? { input: o.input } : {}) })
      if (!r.aborted && !r.timedOut) wrapperExited = true
      if (r.timedOut) await hardKill(id, name, execId, () => false)
      return result(r, false, aborted)
    } finally {
      o.signal?.removeEventListener('abort', onAbort)
      await store.touch(id).catch(() => {})
    }
  }

  async function stopContainer(id: string): Promise<void> {
    await locked(id, async () => {
      const c = await inspect(containerName(id))
      if (c?.State.Running) await docker(['stop', '-t', '3', c.Id], { timeoutMs: 30_000 })
      await store.setContainer(id, c?.Id ?? null, 'stopped')
    })
  }

  /** Remove the container (NOT the files) — workspace deletion. */
  async function removeContainer(id: string): Promise<void> {
    await locked(id, async () => {
      await docker(['rm', '-f', containerName(id)], { timeoutMs: 30_000 })
      await store.setContainer(id, null, 'stopped')
    })
  }

  /** Remove container + files + row (the 30-day sweep). Files are deleted INSIDE a container. */
  async function destroyWorkspace(id: string): Promise<void> {
    await locked(id, async () => {
      await docker(['rm', '-f', containerName(id)], { timeoutMs: 30_000 })
      const dir = hostDir(id)
      await preflight(false)
      const r = await docker(['run', '--rm', '--network', 'none', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', ...labelArgs(id), '--mount', `type=bind,src=${dir},dst=/workspace`,
        s.image, 'find', '/workspace', '-mindepth', '1', '-delete'], { timeoutMs: 300_000 })
      if (r.code !== 0 && !/No such file|invalid mount config|bind source path does not exist/i.test(r.stderr)) throw new Error(`could not empty workspace ${id}: ${r.stderr.trim()}`)
      await rmdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
      await store.remove(id)
    })
  }

  /** Measure bytes + files inside the sandbox (a one-off no-network container when tainted). */
  async function measure(id: string): Promise<{ bytes: number; inodes: number } | null> {
    const row = await liveRow(id)
    let r: DockerResult
    if (row.tainted) r = await execOneOff(id, MEASURE_COMMAND, MEASURE_TIMEOUT_SEC + 10)
    else r = await docker(['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, containerName(id), '/bin/sh', '-c', MEASURE_COMMAND], { timeoutMs: (MEASURE_TIMEOUT_SEC + 20) * 1000 })
    const used = r.code === 0 ? parseDu(r.stdout) : null
    if (used) {
      await store.setUsage(id, used.bytes, used.inodes)
      measuredAt.set(id, now())
    } else measuredAt.delete(id)
    return used
  }

  /** Before a write: refuse when over quota (measured within the last minute, else now). A
   *  measurement that fails or times out counts as OVER (fail closed — rereview #1: `du` timing out
   *  is exactly what millions of files look like). */
  async function checkQuota(id: string): Promise<void> {
    assertDiskOk()
    const row = await liveRow(id)
    let used = { bytes: row.bytesUsed, inodes: row.inodesUsed }
    const at = measuredAt.get(id)
    if (at === undefined || now() - at >= 60_000) {
      if (!row.tainted) {
        try { await ensureContainer(id) } catch (e) { if (!(e instanceof WorkspaceTaintedError)) throw e }
      }
      const m = await measure(id)
      if (!m) throw SandboxQuotaError.unmeasurable()
      used = m
    }
    if (overQuota(used, quota)) throw new SandboxQuotaError(used.bytes, quota.bytes, used.inodes, quota.inodes)
  }

  /** Every 60s: measure running workspaces; over quota → onOverQuota (kills background shells). */
  async function quotaTick(): Promise<Array<{ id: string; bytes: number; inodes: number; over: boolean }>> {
    const out: Array<{ id: string; bytes: number; inodes: number; over: boolean }> = []
    for (const row of await store.listRunning()) {
      try {
        const m = await measure(row.id)
        // Unmeasurable (du failed / timed out) = over quota: fail closed (rereview #1).
        const used = m ?? { bytes: row.bytesUsed, inodes: Number.MAX_SAFE_INTEGER }
        const over = !m || overQuota(used, quota)
        out.push({ id: row.id, ...used, over })
        if (over) {
          log.warn(m ? `[sandbox] workspace ${row.id} over quota (${used.bytes} bytes, ${used.inodes} files)` : `[sandbox] workspace ${row.id} could not be measured — treated as over quota`)
          await onOverQuota(row.id, used)
        }
      } catch (err) { log.warn(`[sandbox] quota check of ${row.id} failed:`, (err as Error).message) }
    }
    return out
  }

  /** Stop containers idle for idleMs (no command). Returns the stopped workspace ids. */
  async function idleStop(): Promise<string[]> {
    const stopped: string[] = []
    for (const row of await store.listRunning()) {
      if (now() - row.lastUsedAt.getTime() < s.idleMs) continue
      try { if (await isBusy(row.id)) continue } catch (err) {
        log.warn(`[sandbox] busy check of ${row.id} failed — not stopping it:`, (err as Error).message)
        continue
      }
      try {
        await stopContainer(row.id)
        stopped.push(row.id)
      } catch (err) { log.warn(`[sandbox] idle stop of ${row.id} failed:`, (err as Error).message) }
    }
    return stopped
  }

  function inScope(c: Inspected): boolean {
    const l = c.Config.Labels ?? {}
    if (Object.keys(labels).length) return Object.entries(labels).every(([k, v]) => l[k] === v)
    return l[LABEL_TEST] === undefined // production never touches test containers
  }

  async function listLabelled(): Promise<Inspected[]> {
    const ls = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_WORKSPACE}`], { timeoutMs: 30_000 })
    if (ls.code !== 0) throw new SandboxUnavailableError(`docker ps failed: ${ls.stderr.trim()}`)
    const ids = ls.stdout.split('\n').map(x => x.trim()).filter(Boolean)
    if (!ids.length) return []
    const r = await docker(['container', 'inspect', ...ids], { timeoutMs: 60_000 })
    // A container removed between ps and inspect makes inspect exit 1 but still print the rest.
    try { return JSON.parse(r.stdout || '[]') as Inspected[] } catch { return [] }
  }

  /** Kill every running in-scope sandbox container; mark their rows stopped; tell onOverQuota. */
  async function stopAllSandboxes(): Promise<string[]> {
    const stopped = new Set<string>()
    try {
      for (const c of (await listLabelled()).filter(inScope)) {
        if (!c.State.Running) continue
        const k = await docker(['kill', c.Id], { timeoutMs: 30_000 })
        if (k.code !== 0) log.error(`[sandbox] low-disk kill of ${c.Id} failed: ${k.stderr.trim()} (retried on the next check)`)
        const wid = c.Config.Labels?.[LABEL_WORKSPACE]
        if (wid && UUID.test(wid)) stopped.add(wid)
      }
    } catch (err) { log.error('[sandbox] low-disk stop failed:', (err as Error).message) }
    for (const row of await store.listRunning()) stopped.add(row.id)
    for (const id of stopped) {
      try {
        const row = await store.get(id)
        if (row?.state === 'running') await store.setContainer(id, row.containerId, 'stopped')
        await onOverQuota(id, { bytes: row?.bytesUsed ?? 0, inodes: row?.inodesUsed ?? 0 })
      } catch (err) { log.warn(`[sandbox] low-disk bookkeeping of ${id} failed:`, (err as Error).message) }
    }
    return [...stopped]
  }

  function lowReason(st: FsStats, resume: boolean): 'bytes' | 'inodes' | null {
    if (st.freeBytes < (resume ? s.resumeFreeBytes : s.minFreeBytes)) return 'bytes'
    if (st.totalInodes > 0) {
      const floor = resume
        ? Math.max(s.resumeFreeInodes, s.resumeFreeInodesRatio * st.totalInodes)
        : Math.max(s.minFreeInodes, s.minFreeInodesRatio * st.totalInodes)
      if (st.freeInodes < floor) return 'inodes'
    }
    return null
  }

  /**
   * Free-space watchdog (review I2 + rereview #1/#3), every 5s: free bytes below minFreeBytes OR
   * free inodes below the inode floor on the workspaces filesystem → kill every sandbox container
   * in scope (incl. tainted one-offs), mark rows stopped, tell onOverQuota, and refuse all commands
   * until BOTH are back above their resume levels. While the episode lasts every check re-kills
   * whatever is running (a container that slipped in or survived a failed kill).
   */
  async function diskCheck(): Promise<DiskCheckResult> {
    const st = await fsStats(s.workspacesDir)
    const base = { freeBytes: st.freeBytes, freeInodes: st.freeInodes }
    if (lowDisk) {
      const still = lowReason(st, true)
      if (!still) {
        lowDisk = null
        log.info(`[sandbox] disk recovered (${st.freeBytes} bytes, ${st.freeInodes} inodes free) — workspace commands allowed again`)
        return { ...base, reason: null, low: false, entered: false, recovered: true, stopped: [] }
      }
      lowDisk = { ...base, reason: still }
      const stopped = await stopAllSandboxes()
      return { ...base, reason: still, low: true, entered: false, recovered: false, stopped }
    }
    const reason = lowReason(st, false)
    if (!reason) return { ...base, reason: null, low: false, entered: false, recovered: false, stopped: [] }
    lowDisk = { ...base, reason }
    log.error(`[sandbox] LOW DISK (${reason}): ${st.freeBytes} bytes / ${st.freeInodes} inodes free under ${s.workspacesDir} — stopping every workspace sandbox`)
    const stopped = await stopAllSandboxes()
    return { ...base, reason, low: true, entered: true, recovered: false, stopped }
  }

  /**
   * Worker boot: remove labelled containers that are orphans (no live row, tainted leftovers, the
   * networked container of a tainted workspace, wrong name, older image or isolation flags) and fix
   * rows whose container is gone. Only containers in this manager's scope are removed.
   */
  async function reconcile(): Promise<{ removed: string[]; repaired: string[] }> {
    const removed: string[] = []
    const repaired: string[] = []
    const all = await listLabelled()
    const img = await docker(['image', 'inspect', '--format', '{{.Id}}', s.image], { timeoutMs: 15_000 })
    const currentImage = img.code === 0 ? img.stdout.trim() : null
    const keep = new Map<string, Inspected>()
    for (const c of all) {
      const wid = c.Config.Labels?.[LABEL_WORKSPACE] ?? ''
      if (!inScope(c)) { if (wid && c.Name === `/${containerName(wid)}`) keep.set(wid, c); continue }
      const row = UUID.test(wid) ? await store.get(wid) : null
      const orphan = !row || row.deletedAt !== null || row.tainted
        || c.Config.Labels?.[LABEL_TAINTED] !== undefined
        || c.Name !== `/${containerName(wid)}`
        || (currentImage !== null && c.Image !== currentImage)
        || c.Config.Labels?.[LABEL_FLAGS] !== flagsHash(containerSpec(wid))
      if (orphan) {
        await docker(['rm', '-f', c.Id], { timeoutMs: 30_000 })
        removed.push(c.Id)
      } else keep.set(wid, c)
    }
    for (const row of await store.listRunning()) {
      const c = keep.get(row.id)
      if (!c) { await store.setContainer(row.id, null, 'stopped'); repaired.push(row.id) }
      else if (c.Id !== row.containerId || !c.State.Running) {
        await store.setContainer(row.id, c.Id, c.State.Running ? 'running' : 'stopped'); repaired.push(row.id)
      }
    }
    return { removed, repaired }
  }

  /** Daily: start the 30-day clock for workspaces of deleted workstreams; destroy expired ones. */
  async function sweep(retentionMs = 30 * 24 * 60 * 60_000): Promise<string[]> {
    await store.stampOrphans()
    const gone: string[] = []
    for (const row of await store.listExpired(new Date(now() - retentionMs))) {
      try { await destroyWorkspace(row.id); gone.push(row.id) } catch (err) { log.warn(`[sandbox] sweep of ${row.id} failed:`, (err as Error).message) }
    }
    return gone
  }

  return {
    settings: s,
    hostDir,
    ensureDir,
    ensureContainer,
    exec,
    taint,
    reenableNetwork,
    stopContainer,
    removeContainer,
    destroyWorkspace,
    checkQuota,
    measure,
    quotaTick,
    idleStop,
    diskCheck,
    isDiskLow: () => lowDisk !== null,
    reconcile,
    sweep,
    available: () => dockerAvailable(docker)
  }
}

export type SandboxManager = ReturnType<typeof createSandboxManager>

let shared: SandboxManager | null = null
/** The worker's manager (lazily created from its env). */
export function sandboxManager(): SandboxManager {
  return shared ??= createSandboxManager()
}

export interface HousekeepingOptions {
  tickMs?: number
  sweepMs?: number
  /** The free-space watchdog interval (review I2: 5s). */
  diskMs?: number
  /** Once per low-disk episode (activity_log + channels notification — main.ts). */
  onLowDisk?: (r: DiskCheckResult) => Promise<void> | void
  /** Once, after the boot reconcile (Task 2: re-attach background shells, re-arm watches). */
  afterReconcile?: () => Promise<void> | void
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

/**
 * Worker housekeeping (spec §2): reconcile once at boot, then every minute idle-stop + quota, the
 * deletion sweep daily, and the free-space watchdog every 5s. Never throws; with no Docker it logs
 * once and keeps checking quietly. Ticks touch Docker only when the DB has running workspaces (the
 * watchdog only on a low-disk episode).
 */
export function startSandboxHousekeeping(m: SandboxManager = sandboxManager(), o: HousekeepingOptions = {}): () => void {
  const log = o.log ?? console
  let stopped = false
  let reconciled = false
  let warned = false
  let lastSweep = 0
  let running: Promise<void> | null = null
  let diskRunning = false
  const step = async () => {
    if (!reconciled) {
      if (!await m.available()) {
        if (!warned) { warned = true; log.warn('[sandbox] Docker is not available — workspace tools are disabled until it is') }
        return
      }
      const r = await m.reconcile()
      reconciled = true
      log.info(`[sandbox] reconciled: ${r.removed.length} orphan container(s) removed, ${r.repaired.length} row(s) repaired`)
      await o.afterReconcile?.()
    }
    if (m.isDiskLow()) return
    await m.idleStop()
    if (stopped) return
    await m.quotaTick()
    if (stopped) return
    if (Date.now() - lastSweep >= (o.sweepMs ?? 24 * 60 * 60_000)) {
      lastSweep = Date.now()
      const gone = await m.sweep()
      if (gone.length) log.info(`[sandbox] swept ${gone.length} deleted workspace(s)`)
    }
  }
  const tick = () => {
    if (stopped || running) return
    running = step().catch(err => log.error('[sandbox] housekeeping failed:', err)).finally(() => { running = null })
  }
  const disk = () => {
    if (stopped || diskRunning) return
    diskRunning = true
    m.diskCheck()
      .then(async (r) => { if (r.entered) await o.onLowDisk?.(r) })
      .catch(err => log.error('[sandbox] disk watchdog failed:', err))
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
