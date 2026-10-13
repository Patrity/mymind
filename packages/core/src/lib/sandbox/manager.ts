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
  LABEL_EVAL_RUN, LABEL_EVAL_WORLD, LABEL_FLAGS, evalContainerPrefix, registerEvalSandbox, LABEL_TAINTED, LABEL_TEST, LABEL_WORKSPACE, SANDBOX_UID, SandboxStoppedError, SandboxUnavailableError,
  assertSecretName, createArgs, createDockerCli, dockerAvailable, ensureNetwork, execArgs, flagsHash, killExecArgs,
  limitsProbeArgs, limitsProblems, parseExecStatus, taintedRunArgs, verifyNetworkIsolation,
  type DockerResult, type DockerRunner, type ExecStatus
} from './docker'
import { DEFAULT_SANDBOX_DNS } from './network'
import { DEFAULT_QUOTA_BYTES, DEFAULT_QUOTA_INODES, MEASURE_COMMAND, MEASURE_TIMEOUT_SEC, SandboxDiskLowError, SandboxQuotaError, overQuota, parseDu } from './quota'
import { dbWorkspaceStore, type WorkspaceRow, type WorkspaceStore } from './store'
import { coreConfig } from '../../config'
import { sandboxRequireFirewall, sandboxRequireLimits } from '../../config-env'
import type { SandboxHealth } from '../../shared/types/workspaces'
import { currentEvalScope, type EvalScope } from '../eval/context'

export { SandboxStoppedError, SandboxUnavailableError } from './docker'
export { SandboxQuotaError, SandboxDiskLowError } from './quota'

export interface SandboxSettings {
  image: string
  workspacesDir: string
  /** Resolvers for the sandbox network ([] = Docker's default). */
  dns: string[]
  /** 'enforce': refuse to run unless the live iptables rules match network.ts. */
  firewall: 'enforce' | 'off'
  /** 'enforce' (final review I4): refuse to run unless a probe container shows the memory + pids
   *  limits really applied (HostConfig AND the cgroup files inside it) — an unprivileged LXC can
   *  discard them with only a warning. */
  limits: 'enforce' | 'off'
  /** Final review I3: at most this many sandbox containers run at once (networked + tainted one-offs). */
  maxRunning: number
  /** …a start that finds no free slot (and nothing idle to stop) waits this long, then fails. */
  slotWaitMs: number
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

function limitsRequired(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  try { return coreConfig().sandboxRequireLimits } catch { return sandboxRequireLimits(env, platform) }
}

function positiveInt(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : dflt
}

/** Settings from the worker's env. The firewall and limits gates are CoreConfig.sandboxRequire*. */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, requireFirewall = firewallRequired(env, platform), requireLimits = limitsRequired(env, platform)): SandboxSettings {
  const prod = env.NODE_ENV === 'production'
  const linux = platform === 'linux'
  return {
    image: env.SANDBOX_IMAGE || 'mymind-sandbox:current',
    workspacesDir: path.resolve(env.SANDBOX_WORKSPACES_DIR || (prod ? '/opt/mymind/.workspaces' : '.data/workspaces')),
    // Docker Desktop drops outbound UDP to public resolvers, so dev on macOS keeps Docker's own.
    dns: env.SANDBOX_DNS !== undefined ? env.SANDBOX_DNS.split(',').map(s => s.trim()).filter(Boolean) : linux ? [...DEFAULT_SANDBOX_DNS] : [],
    firewall: requireFirewall ? 'enforce' : 'off',
    limits: requireLimits ? 'enforce' : 'off',
    maxRunning: positiveInt(env.SANDBOX_MAX_RUNNING, 2),
    slotWaitMs: 60_000,
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
  /** Final follow-up: ran with no network and no secrets in a throwaway container because the run is
   *  tainted ONLY `unverified` (a guard check that could not run) — the workspace was NOT tainted. */
  offline?: boolean
}

export interface ExecOptions {
  timeoutSec?: number
  signal?: AbortSignal
  /** Opted-in sandbox secrets (spec §6) — never passed to tainted runs / tainted workspaces. */
  secrets?: Record<string, string>
  /** The run has read untrusted content: no network (spec D5) — and the workspace becomes tainted. */
  tainted?: boolean
  /** Final follow-up (I5): the run is tainted only `unverified` — no network and no secrets (a one-off
   *  container), but the workspace is NOT marked tainted. `tainted` wins when both are set. */
  offline?: boolean
  /** Fed to the command's stdin (file contents — never in argv: 128 KB cap and visible in /proc). */
  input?: string
  /** Output cap per stream (tail kept). Default settings.outputCapBytes (64 KB); at most 1 MB. */
  capBytes?: number
  /** Final review M5: never START a container for this command (an API-token read of the Files /
   *  Shells UI) — a stopped (or tainted) workspace refuses with SandboxStoppedError. */
  noStart?: boolean
}

/** Hooks the workspace runtime (Task 2: background shells + watches) installs on the shared
 *  manager at worker start — set once, read at call time (no import cycle with the tools). */
export interface SandboxRuntimeHooks {
  /** Armed watches: the container is neither idle-stopped nor evicted for capacity. */
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
  /** Running background shells: the container is not evicted for capacity (final review I3). They
   *  do NOT block the idle stop (I2 ruling: 15 min with no command and no output read stops it). */
  hasLiveShell?: (workspaceId: string) => boolean | Promise<boolean>
  onOverQuota?: (workspaceId: string, usage: { bytes: number; inodes: number }) => Promise<void> | void
  /** After a command made the workspace tainted (or ran in an already tainted one). */
  onTainted?: (workspaceId: string) => Promise<void> | void
  /** The manager stopped the container (idle, capacity eviction, workstream ended): its background
   *  shells died with it — record them. */
  onStopped?: (workspaceId: string, reason: string) => Promise<void> | void
  /** Every quota tick, per running workspace, before measuring: refresh running shell rows (one that
   *  exited is recorded — final review I2). Must not count as use (never touches last_used_at). */
  refresh?: (workspaceId: string) => Promise<void> | void
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
  /** True while a workspace must not be idle-stopped or evicted (armed watches — Task 2). */
  isBusy?: (workspaceId: string) => boolean | Promise<boolean>
  hasLiveShell?: (workspaceId: string) => boolean | Promise<boolean>
  onStopped?: (workspaceId: string, reason: string) => Promise<void> | void
  refresh?: (workspaceId: string) => Promise<void> | void
  /** Called when a workspace is over quota or stopped by the low-disk watchdog (Task 2 kills its
   *  background shells). */
  onOverQuota?: (workspaceId: string, usage: { bytes: number; inodes: number }) => Promise<void> | void
  onTainted?: (workspaceId: string) => Promise<void> | void
  log?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => number
  uid?: number | undefined
  platform?: NodeJS.Platform
  /** Cycle 85: an eval world's manager — every container `--network none` (no firewall preflight
   *  needed), and a command with secrets is refused (fail closed). */
  offline?: boolean
  /** Fix round 2 (N1): every container name starts with this (an eval world's own prefix) instead of
   *  `mymind-`. */
  namePrefix?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREFLIGHT_TTL_MS = 60_000
export const IDLE_STOP_REASON = 'stopped: the sandbox was idle for 15 min (no command, no output read) — background shells are for jobs, not servers'
export const EVICTED_REASON = 'stopped: another workspace needed its sandbox slot'

export type { SandboxHealth }

export function containerName(workspaceId: string): string {
  return `mymind-ws-${workspaceId}`
}

/** Thrown inside the lock when a tainted workspace would get its networked container. */
class WorkspaceTaintedError extends Error {}
/** A start needs a capacity slot, which is acquired outside the workspace lock (follow-up N1c). */
class NeedSlot extends Error {}
/** The request was aborted while it waited for a capacity slot. */
class SlotWaitAborted extends Error {}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

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
  const offline = opts.offline === true
  const namePrefix = opts.namePrefix ?? 'mymind-'
  /** The workspace container's name: `mymind-ws-<id>`, or under an eval world's prefix (N1). */
  const cname = (id: string) => namePrefix === 'mymind-' ? containerName(id) : `${namePrefix}ws-${id}`
  const log = opts.log ?? console
  const now = opts.now ?? Date.now
  const uid = 'uid' in opts ? opts.uid : process.getuid?.()
  const platform = opts.platform ?? process.platform
  const fsStats = opts.fsStats ?? defaultFsStats
  const isBusy = (id: string) => (opts.isBusy ?? runtimeHooks.isBusy)?.(id) ?? false
  const hasLiveShell = (id: string) => (opts.hasLiveShell ?? runtimeHooks.hasLiveShell)?.(id) ?? false
  const onStopped = (id: string, reason: string) => (opts.onStopped ?? runtimeHooks.onStopped)?.(id, reason)
  const refreshShells = (id: string) => (opts.refresh ?? runtimeHooks.refresh)?.(id)
  const onOverQuota = (id: string, usage: { bytes: number; inodes: number }) => (opts.onOverQuota ?? runtimeHooks.onOverQuota)?.(id, usage)
  const onTainted = (id: string) => (opts.onTainted ?? runtimeHooks.onTainted)?.(id)
  /** Abort handles of tainted one-offs in flight, per workspace — registered under the workspace
   *  lock by `taint()`, so a re-enable (same lock) always sees every one (rereview #5). */
  const taintedInFlight = new Map<string, Set<AbortController>>()
  const quota = { bytes: s.quotaBytes, inodes: s.quotaInodes }
  const locks = new Map<string, Promise<unknown>>()
  const measuredAt = new Map<string, number>()
  let preflightOk: { at: number; network: boolean } | null = null
  /** Limits verified once per manager (I4); a failure is cached for PREFLIGHT_TTL_MS. */
  let limitsOk = false
  let limitsFailed: { at: number; message: string } | null = null
  /** Commands in flight per workspace (networked container) — never idle-stopped or evicted (M1, I3). */
  const inFlight = new Map<string, number>()
  /** Tainted one-off containers in flight (reporting; they hold a reserved slot while they run). */
  let oneOffs = 0
  /** Slots granted and not yet released: starts in progress + one-offs in flight (I3 / N1). */
  let reserved = 0
  /** Global capacity lock: count + start happen under it, so two starts can't both take the last slot. */
  let capacityChain: Promise<unknown> = Promise.resolve()
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

  async function preflight(wantNetwork: boolean): Promise<void> {
    const needNetwork = wantNetwork && !offline
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
    if (s.limits === 'enforce' && !limitsOk) await verifyLimits()
    preflightOk = { at: now(), network: needNetwork || (preflightOk?.network ?? false) }
  }

  /**
   * Final review I4: are the memory + pids limits REALLY applied? A probe container (no network, the
   * same isolation flags as every sandbox) is created, its HostConfig inspected, then started to read
   * its own cgroup memory.max / pids.max. Docker on an unprivileged LXC whose controllers aren't
   * delegated accepts `--memory`/`--pids-limit` with a warning and discards them — fail closed.
   */
  async function verifyLimits(): Promise<void> {
    if (limitsFailed && now() - limitsFailed.at < PREFLIGHT_TTL_MS) throw new SandboxUnavailableError(limitsFailed.message)
    const name = `${namePrefix}wsprobe-${randomBytes(4).toString('hex')}`
    const dir = path.join(s.workspacesDir, '.limits-probe')
    await mkdir(dir, { recursive: true, mode: 0o711 })
    const fail = (why: string) => {
      const message = `the workspace sandbox is unavailable: its resource limits are not enforced on this host (${why}) — the memory/pids cgroup controllers must be delegated to Docker (or set SANDBOX_REQUIRE_LIMITS=false to accept unbounded sandboxes)`
      limitsFailed = { at: now(), message }
      log.error(`[sandbox] limits check failed: ${why}`)
      return new SandboxUnavailableError(message)
    }
    try {
      const c = await docker(limitsProbeArgs({ name, image: s.image, workspaceId: 'limits-probe', hostDir: dir, labels, probe: true }), { timeoutMs: 60_000 })
      if (c.code !== 0) throw fail(`the probe container could not be created: ${c.stderr.trim().slice(0, 200)}`)
      const hc = await docker(['container', 'inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}', name], { timeoutMs: 15_000 })
      const run = await docker(['start', '-a', name], { timeoutMs: 60_000 })
      const problems = limitsProblems(hc.stdout, run.stdout)
      if (problems.length) throw fail(problems.join('; '))
      limitsOk = true
      limitsFailed = null
    } finally {
      await docker(['rm', '-f', name], { timeoutMs: 30_000 })
    }
  }

  /** The worker's boot check (I6): ok, or the reason the sandbox is unavailable. Never throws. */
  async function health(): Promise<SandboxHealth> {
    const checkedAt = new Date(now()).toISOString()
    if (lowDisk) return { ok: false, reason: `the server is low on disk (${(lowDisk.freeBytes / 1024 ** 3).toFixed(1)} GB free) — every sandbox is stopped until space is freed`, checkedAt }
    try {
      preflightOk = null // a fresh look every time
      await preflight(true)
      return { ok: true, checkedAt }
    } catch (err) {
      const msg = (err as Error).message.replace(/^the workspace sandbox is unavailable: /, '')
      return { ok: false, reason: msg, checkedAt }
    }
  }

  /** Serialise every capacity decision (count + start) across workspaces. */
  function withCapacity<T>(fn: () => Promise<T>): Promise<T> {
    const next = capacityChain.catch(() => {}).then(fn)
    capacityChain = next.catch(() => {})
    return next
  }

  /** Kind per workspace id (it never changes) — the home workspace has its own reserved slot. */
  const kinds = new Map<string, WorkspaceRow['kind'] | null>()
  async function isHome(id: string): Promise<boolean> {
    if (!kinds.has(id)) kinds.set(id, (await store.get(id))?.kind ?? null)
    return kinds.get(id) === 'home'
  }

  /** Running networked workspace containers in this manager's scope (docker is the truth),
   *  except the home workspace's (follow-up N1b: it has a reserved slot outside the count). */
  async function runningNetworked(): Promise<string[]> {
    const ids = (await listLabelled()).filter((c) => {
      const wid = c.Config.Labels?.[LABEL_WORKSPACE] ?? ''
      return inScope(c) && c.State.Running && c.Config.Labels?.[LABEL_TAINTED] === undefined && UUID.test(wid) && c.Name === `/${cname(wid)}`
    }).map(c => c.Config.Labels![LABEL_WORKSPACE]!)
    const out: string[] = []
    for (const id of ids) if (!await isHome(id)) out.push(id)
    return out
  }

  /** The least-recently-used running workspace nothing is using right now (no command in flight, no
   *  live background shell, nobody holding its lock) — or null. Follow-up N1a: an armed watch does
   *  NOT pin it (its next poll takes a slot again); only a live shell does. */
  async function pickVictim(candidates: string[]): Promise<string | null> {
    let best: { id: string; at: number } | null = null
    for (const id of candidates) {
      if (locks.has(id) || (inFlight.get(id) ?? 0) > 0) continue
      try { if (await hasLiveShell(id)) continue } catch { continue }
      const row = await store.get(id)
      const at = row?.lastUsedAt.getTime() ?? 0
      if (!best || at < best.at) best = { id, at }
    }
    return best?.id ?? null
  }

  /**
   * Stop a capacity victim — under ITS lock (follow-up N2: the pins are re-checked there, a shell
   * may have started since it was picked). false = not evicted: something pins it now, or the
   * container would not stop (N3 — the caller skips it; the row is not marked stopped).
   */
  async function evictUnlocked(id: string): Promise<boolean> {
    if ((inFlight.get(id) ?? 0) > 0) return false
    try { if (await hasLiveShell(id)) return false } catch { return false }
    const c = await inspect(cname(id))
    if (c?.State.Running) {
      await docker(['stop', '-t', '3', c.Id], { timeoutMs: 30_000 })
      if ((await inspect(c.Id))?.State.Running) {
        log.warn(`[sandbox] capacity: ${id} would not stop — skipped as a victim`)
        return false
      }
    }
    await store.setContainer(id, c?.Id ?? null, 'stopped')
    try { await onStopped(id, EVICTED_REASON) } catch (err) { log.warn(`[sandbox] onStopped(${id}) failed:`, (err as Error).message) }
    return true
  }

  /**
   * Final review I3 + follow-up N1c: a slot for one more running sandbox container (a networked
   * start or a one-off). Waits OUTSIDE every workspace lock, until `deadline` (60s from the
   * request's entry, never restarted) — the capacity lock is held only for one count/evict pass at
   * a time. Full → stop the LRU unpinned one; none → poll until the deadline, then a clear error.
   * An abort ends the wait at once (SlotWaitAborted). The home workspace never waits (N1b).
   * Returns release() — call it once the container runs (docker counts it from then) or ends.
   */
  async function acquireSlot(forId: string, o: { deadline: number; signal?: AbortSignal }): Promise<() => void> {
    if (await isHome(forId)) return () => {}
    const skip = new Set<string>()
    for (;;) {
      if (o.signal?.aborted) throw new SlotWaitAborted()
      const got = await withCapacity(async (): Promise<number | true> => {
        for (;;) {
          const running = (await runningNetworked()).filter(id => id !== forId)
          const used = running.length + reserved
          if (used < s.maxRunning) { reserved++; return true }
          // N3: the deadline is checked on every pass, and a victim that won't stop is skipped.
          if (Date.now() >= o.deadline || o.signal?.aborted) return used
          const victim = await pickVictim(running.filter(id => !skip.has(id)))
          if (!victim || locks.has(victim)) return used
          log.info(`[sandbox] capacity: ${used}/${s.maxRunning} sandboxes running — stopping the least recently used one (${victim}) for ${forId}`)
          if (!await locked(victim, () => evictUnlocked(victim))) skip.add(victim)
        }
      })
      if (got === true) {
        let done = false
        return () => { if (!done) { done = true; reserved-- } }
      }
      if (Date.now() >= o.deadline) throw new SandboxUnavailableError(`sandbox capacity busy — ${got} workspaces active (at most ${s.maxRunning} sandboxes run at once). Try again in a few minutes.`)
      await abortableSleep(Math.min(1000, Math.max(10, s.slotWaitMs / 20)), o.signal)
    }
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
    return { name: cname(id), image: s.image, workspaceId: id, hostDir: hostDir(id), labels, dns: offline ? [] : s.dns, ...(offline ? { network: 'none' } : {}) }
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

  /** `slot`: the caller holds a capacity slot (acquireSlot) — without one, a start throws NeedSlot
   *  and the caller acquires one OUTSIDE this workspace's lock (follow-up N1c). */
  async function ensureContainerUnlocked(id: string, o: { noStart?: boolean; slot?: boolean } = {}): Promise<{ containerId: string; name: string }> {
    assertDiskOk()
    const row = await liveRow(id)
    // Re-read under the lock: a taint that just landed must never be raced by a networked start.
    if (row.tainted) throw new WorkspaceTaintedError(`workspace ${id} is tainted`)
    await preflight(true)
    const name = cname(id)
    const wantFlags = flagsHash(containerSpec(id))
    const current = await inspect(name)
    const fresh = (c: Inspected) => !(imageId && c.Image !== imageId) && c.Config.Labels?.[LABEL_FLAGS] === wantFlags
    if (current?.State.Running && fresh(current)) {
      await store.setContainer(id, current.Id, 'running')
      await store.touch(id) // M1: inside the lock — an idle stop re-checking under it sees the use
      return { containerId: current.Id, name }
    }
    if (o.noStart) throw new SandboxStoppedError()
    if (!o.slot) throw new NeedSlot()
    const r = await createOrStart(id, name, wantFlags)
    await store.touch(id)
    return r
  }

  async function createOrStart(id: string, name: string, wantFlags: string): Promise<{ containerId: string; name: string }> {
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

  /**
   * The workspace's networked container, running. A running one is just used (under the lock);
   * starting one first takes a capacity slot — waited for OUTSIDE the workspace lock (N1c), so
   * taint, re-enable, teardown and hard-kill on this workspace never queue behind a slot wait.
   * `deadline` is fixed at the request's entry; `signal` aborts the wait.
   */
  async function ensureContainer(id: string, o: { noStart?: boolean; signal?: AbortSignal; deadline?: number } = {}): Promise<{ containerId: string; name: string }> {
    const deadline = o.deadline ?? Date.now() + s.slotWaitMs
    for (;;) {
      try { return await locked(id, () => ensureContainerUnlocked(id, { noStart: o.noStart })) } catch (e) {
        if (!(e instanceof NeedSlot)) throw e
      }
      const release = await acquireSlot(id, { deadline, signal: o.signal })
      try {
        return await locked(id, () => ensureContainerUnlocked(id, { slot: true }))
      } finally { release() }
    }
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
      const c = await inspect(cname(id))
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
   * Cycle 84 Task 3: taint a workspace WITHOUT running a command — the output guard flagged content
   * read from it (a file, command output). Same effect as a tainted command's taint: flag first, the
   * networked container killed, the runtime hook (shells recorded, watches cancelled). Fails closed
   * like taint(): a container that won't stop throws (the flag is already set).
   */
  async function markTainted(id: string): Promise<void> {
    releaseTainted(id, await taint(id))
    try { await onTainted(id) } catch (err) { log.warn(`[sandbox] onTainted(${id}) failed:`, (err as Error).message) }
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
  async function execOneOff(id: string, command: string, timeoutSec: number, signal?: AbortSignal, io: { input?: string; capBytes?: number; deadline?: number } = {}): Promise<DockerResult & { abortedHere: boolean }> {
    await preflight(false)
    await ensureDir(id)
    // I3: a one-off takes a sandbox slot for as long as it runs (N1c: waited for here, outside any
    // workspace lock; bounded by the request's deadline; an abort ends the wait).
    const release = await acquireSlot(id, { deadline: io.deadline ?? Date.now() + s.slotWaitMs, signal })
    oneOffs++
    try { return await execOneOffInSlot(id, command, timeoutSec, signal, io) } finally { oneOffs--; release() }
  }

  async function execOneOffInSlot(id: string, command: string, timeoutSec: number, signal: AbortSignal | undefined, io: { input?: string; capBytes?: number }): Promise<DockerResult & { abortedHere: boolean }> {
    const execId = newExecId()
    const name = `${namePrefix}wst-${id.slice(0, 8)}-${execId}`
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
    // N1c: a capacity wait is bounded from HERE (the request's entry), never restarted later.
    const deadline = Date.now() + s.slotWaitMs
    const abortedWait = () => result({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }, false, true)
    assertDiskOk()
    const timeoutSec = timeoutOf(o.timeoutSec)
    const capBytes = Math.min(MAX_CAP_BYTES, Math.max(1024, Math.floor(o.capBytes ?? s.outputCapBytes)))
    const io = { capBytes, ...(o.input !== undefined ? { input: o.input } : {}) }
    const secrets = o.secrets ?? {}
    for (const k of Object.keys(secrets)) assertSecretName(k)
    if (offline && Object.keys(secrets).length) throw new SandboxUnavailableError('eval: sandbox secrets are never available in an eval world')
    const row = await liveRow(id)
    if (o.noStart && (o.tainted || o.offline || row.tainted)) throw new SandboxStoppedError()
    const runTainted = async () => {
      const ctrl = await taint(id)
      // Fix round 1 (M2): the workspace is offline now — its watches are cancelled and its shells
      // recorded as stopped (the runtime hook; idempotent, cheap when there is nothing).
      try { await onTainted(id) } catch (err) { log.warn(`[sandbox] onTainted(${id}) failed:`, (err as Error).message) }
      try {
        await store.touch(id)
        const signal = o.signal ? AbortSignal.any([o.signal, ctrl.signal]) : ctrl.signal
        const r = await execOneOff(id, command, timeoutSec, signal, { ...io, deadline })
        return result(r, true, r.abortedHere)
      } catch (e) {
        if (e instanceof SlotWaitAborted) return { ...abortedWait(), tainted: true }
        throw e
      } finally { releaseTainted(id, ctrl) }
    }
    if (o.tainted || row.tainted) return runTainted()
    // Follow-up (I5): offline only — a one-off with no network and no secrets; no flag, no kill.
    if (o.offline) {
      try {
        await store.touch(id)
        const r = await execOneOff(id, command, timeoutSec, o.signal, { ...io, deadline })
        return { ...result(r, false, r.abortedHere), offline: true }
      } catch (e) {
        if (e instanceof SlotWaitAborted) return { ...abortedWait(), offline: true }
        throw e
      }
    }

    // In flight from BEFORE the container is ensured until the command returns: an idle stop or a
    // capacity eviction never picks a workspace a command is about to run in (M1, I3).
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1)
    let tainted = false
    try {
      let name: string
      try { ({ name } = await ensureContainer(id, { noStart: o.noStart, signal: o.signal, deadline })) } catch (e) {
        if (e instanceof SlotWaitAborted) return abortedWait()
        if (!(e instanceof WorkspaceTaintedError)) throw e
        if (o.noStart) throw new SandboxStoppedError()
        tainted = true
        name = ''
      }
      if (!tainted) return await execNetworked(id, name, command, o, { timeoutSec, capBytes, secrets })
    } finally {
      const n = (inFlight.get(id) ?? 1) - 1
      if (n > 0) inFlight.set(id, n)
      else inFlight.delete(id)
    }
    return runTainted()
  }

  async function execNetworked(id: string, name: string, command: string, o: ExecOptions, x: { timeoutSec: number; capBytes: number; secrets: Record<string, string> }): Promise<SandboxExecResult> {
    const { timeoutSec, capBytes, secrets } = x
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

  /** Stop the container (files kept). `reason` goes to its background shells' rows (onStopped). */
  async function stopContainer(id: string, reason = 'stopped: the sandbox was stopped'): Promise<void> {
    await locked(id, () => stopUnlocked(id, reason))
  }

  async function stopUnlocked(id: string, reason: string): Promise<void> {
    const c = await inspect(cname(id))
    if (c?.State.Running) await docker(['stop', '-t', '3', c.Id], { timeoutMs: 30_000 })
    await store.setContainer(id, c?.Id ?? null, 'stopped')
    try { await onStopped(id, reason) } catch (err) { log.warn(`[sandbox] onStopped(${id}) failed:`, (err as Error).message) }
  }

  /**
   * Follow-up N4: act only if `guard()` still holds UNDER the workspace lock — then run `before`
   * (still under it) and stop the container. Used by the workstream teardown, so a resume that
   * lands between "it ended" and the teardown keeps its shells, watches and container.
   */
  async function stopIf(id: string, guard: () => Promise<boolean>, before: () => Promise<void>, reason: string): Promise<boolean> {
    return locked(id, async () => {
      if (!await guard()) return false
      await before()
      await stopUnlocked(id, reason)
      return true
    })
  }

  /** M1: the idle decision is re-made UNDER the workspace lock (a command that started since the
   *  tick's snapshot touched last_used_at inside ensureContainer's lock, or is in flight). */
  async function stopIfIdle(id: string): Promise<boolean> {
    return locked(id, async () => {
      const row = await store.get(id)
      if (!row || row.state !== 'running') return false
      if (now() - row.lastUsedAt.getTime() < s.idleMs || (inFlight.get(id) ?? 0) > 0) return false
      if (await isBusy(id)) return false
      await stopUnlocked(id, IDLE_STOP_REASON)
      return true
    })
  }

  /**
   * A housekeeping command in the RUNNING networked container (final review I2: the shell liveness
   * refresh). null when the workspace is not running (or is tainted) — it never starts a container,
   * never counts as use (no touch) and never runs with secrets.
   */
  async function peek(id: string, command: string): Promise<SandboxExecResult | null> {
    const row = await store.get(id)
    if (!row || row.state !== 'running' || row.tainted || row.deletedAt) return null
    const r = await docker(['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, '--workdir', '/workspace', cname(id), '/bin/sh', '-c', command], { timeoutMs: 30_000, capBytes: s.outputCapBytes })
    if (r.code !== 0 && /is not running|No such container/i.test(r.stderr)) return null
    return result(r, false, false)
  }

  /** Remove the container (NOT the files) — workspace deletion. */
  async function removeContainer(id: string): Promise<void> {
    await locked(id, async () => {
      await docker(['rm', '-f', cname(id)], { timeoutMs: 30_000 })
      await store.setContainer(id, null, 'stopped')
    })
  }

  /** Remove container + files + row (the 30-day sweep). Files are deleted INSIDE a container. */
  async function destroyWorkspace(id: string): Promise<void> {
    await locked(id, async () => {
      await docker(['rm', '-f', cname(id)], { timeoutMs: 30_000 })
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
  async function measure(id: string, o: { oneOff?: boolean } = {}): Promise<{ bytes: number; inodes: number } | null> {
    const row = await liveRow(id)
    let r: DockerResult
    if (row.tainted || o.oneOff) r = await execOneOff(id, MEASURE_COMMAND, MEASURE_TIMEOUT_SEC + 10)
    else r = await docker(['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, cname(id), '/bin/sh', '-c', MEASURE_COMMAND], { timeoutMs: (MEASURE_TIMEOUT_SEC + 20) * 1000 })
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
  async function checkQuota(id: string, o: { tainted?: boolean; offline?: boolean } = {}): Promise<void> {
    assertDiskOk()
    const row = await liveRow(id)
    let used = { bytes: row.bytesUsed, inodes: row.inodesUsed }
    const at = measuredAt.get(id)
    if (at === undefined || now() - at >= 60_000) {
      // A tainted RUN measures in a no-network one-off (fix round 1, M8): never start the networked
      // container just to measure, right before the tainted command stops it again.
      const oneOff = row.tainted || o.tainted === true || o.offline === true
      if (!oneOff) {
        try { await ensureContainer(id) } catch (e) { if (!(e instanceof WorkspaceTaintedError)) throw e }
      }
      const m = await measure(id, { oneOff })
      if (!m) throw SandboxQuotaError.unmeasurable()
      used = m
    }
    if (overQuota(used, quota)) throw new SandboxQuotaError(used.bytes, quota.bytes, used.inodes, quota.inodes)
  }

  /** Every 60s: measure running workspaces; over quota → onOverQuota (kills background shells). */
  async function quotaTick(): Promise<Array<{ id: string; bytes: number; inodes: number; over: boolean }>> {
    const out: Array<{ id: string; bytes: number; inodes: number; over: boolean }> = []
    for (const row of await store.listRunning()) {
      try { await refreshShells(row.id) } catch (err) { log.warn(`[sandbox] shell refresh of ${row.id} failed:`, (err as Error).message) }
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

  /** Stop containers idle for idleMs (no command, no output read; armed watches keep one up — a
   *  running background shell does not, I2 ruling). Returns the stopped workspace ids. */
  async function idleStop(): Promise<string[]> {
    const stopped: string[] = []
    for (const row of await store.listRunning()) {
      if (now() - row.lastUsedAt.getTime() < s.idleMs) continue
      try { if (await isBusy(row.id)) continue } catch (err) {
        log.warn(`[sandbox] busy check of ${row.id} failed — not stopping it:`, (err as Error).message)
        continue
      }
      try {
        if (await stopIfIdle(row.id)) stopped.push(row.id)
      } catch (err) { log.warn(`[sandbox] idle stop of ${row.id} failed:`, (err as Error).message) }
    }
    return stopped
  }

  function inScope(c: Inspected): boolean {
    const l = c.Config.Labels ?? {}
    if (Object.keys(labels).length) return Object.entries(labels).every(([k, v]) => l[k] === v)
    // Production never touches test containers, nor an eval world's (cycle 85: they are not its
    // orphans, never count against its slots; cleanupEvalRun / the boot sweep remove them).
    return l[LABEL_TEST] === undefined && l[LABEL_EVAL_RUN] === undefined
  }

  async function listLabelled(): Promise<Inspected[]> {
    // Scoped by this manager's own labels too (an eval world lists only its own containers — N1).
    const ls = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_WORKSPACE}`, ...Object.entries(labels).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`])], { timeoutMs: 30_000 })
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
      if (!inScope(c)) { if (wid && c.Name === `/${cname(wid)}`) keep.set(wid, c); continue }
      const row = UUID.test(wid) ? await store.get(wid) : null
      const orphan = !row || row.deletedAt !== null || row.tainted
        || c.Config.Labels?.[LABEL_TAINTED] !== undefined
        || c.Name !== `/${cname(wid)}`
        || (currentImage !== null && c.Image !== currentImage)
        || c.Config.Labels?.[LABEL_FLAGS] !== flagsHash(containerSpec(wid))
      if (orphan) {
        await docker(['rm', '-f', c.Id], { timeoutMs: 30_000 })
        removed.push(c.Id)
      } else keep.set(wid, c)
    }
    const runningRows = new Set<string>()
    for (const row of await store.listRunning()) {
      runningRows.add(row.id)
      const c = keep.get(row.id)
      if (!c) { await store.setContainer(row.id, null, 'stopped'); repaired.push(row.id) }
      else if (c.Id !== row.containerId || !c.State.Running) {
        await store.setContainer(row.id, c.Id, c.State.Running ? 'running' : 'stopped'); repaired.push(row.id)
      }
    }
    // M2: a container that RUNS while its row says stopped (a crash between `docker start` and the
    // row update) would never be idle-stopped or counted — stop it.
    for (const [wid, c] of keep) {
      if (!c.State.Running || runningRows.has(wid) || !inScope(c)) continue
      await docker(['stop', '-t', '3', c.Id], { timeoutMs: 30_000 })
      if (UUID.test(wid) && await store.get(wid)) await store.setContainer(wid, c.Id, 'stopped')
      repaired.push(wid)
    }
    return { removed, repaired }
  }

  /** Daily: start the 30-day clock for workspaces of deleted workstreams; destroy expired ones —
   *  deleted 30 days ago, or (final review I7) their workstream finished 30 days ago. */
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
    /** The labels scoping this manager, and whether it is an offline (eval) one. */
    labels,
    offline,
    hostDir,
    ensureDir,
    ensureContainer,
    exec,
    taint,
    markTainted,
    reenableNetwork,
    stopContainer,
    stopIf,
    peek,
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
    health,
    /** Commands in flight / one-offs running (tests). */
    load: () => ({ inFlight: [...inFlight.entries()], oneOffs, reserved }),
    available: () => dockerAvailable(docker)
  }
}

export type SandboxManager = ReturnType<typeof createSandboxManager>

let shared: SandboxManager | null = null
const evalManagers = new WeakMap<EvalScope, SandboxManager>()
/** Fix round 2 (N6): each eval world's manager calls ITS runtime's hooks (its shells / watches),
 *  never Tony's global ones. runtime.ts registers them per scope. */
const evalHooks = new WeakMap<object, SandboxRuntimeHooks>()
export function setEvalSandboxHooks(scope: object, hooks: SandboxRuntimeHooks): void { evalHooks.set(scope, hooks) }
/** Tests: the hooks registered for a world. */
export function _evalSandboxHooksFor(scope: object): SandboxRuntimeHooks | undefined { return evalHooks.get(scope) }

/** The worker's manager (lazily created from its env) — or, inside an eval world, that world's own
 *  offline, eval-labelled manager (cycle 85): Tony's manager is never reachable from a world. */
export function sandboxManager(): SandboxManager {
  const scope = currentEvalScope()
  if (scope) {
    let m = evalManagers.get(scope)
    if (!m) evalManagers.set(scope, m = createEvalSandboxManager(scope))
    return m
  }
  return shared ??= createSandboxManager()
}

/** Where an eval world's workspace dirs live (removed by cleanupEvalRun / the boot sweep). */
export function evalWorkspacesDir(worldId: string, base = sandboxSettings().workspacesDir): string {
  return path.join(base, '.eval', worldId)
}

export function evalSandboxLabels(scope: Pick<EvalScope, 'runId' | 'worldId'>): Record<string, string> {
  return { [LABEL_EVAL_RUN]: scope.runId, [LABEL_EVAL_WORLD]: scope.worldId }
}

/** An eval world's manager: offline, labelled with the run + world, its own dir and slots. */
export function createEvalSandboxManager(scope: Pick<EvalScope, 'runId' | 'worldId'>, opts: SandboxManagerOptions = {}): SandboxManager {
  const h = () => evalHooks.get(scope) ?? {}
  // Fix round 3 (B1): the docker guard lets this world mount only its own dir and run its image.
  registerEvalSandbox(scope.worldId, { workspacesDir: evalWorkspacesDir(scope.worldId, opts.settings?.workspacesDir), image: opts.settings?.image ?? sandboxSettings().image })
  return createSandboxManager({
    isBusy: id => h().isBusy?.(id) ?? false,
    hasLiveShell: id => h().hasLiveShell?.(id) ?? false,
    onStopped: (id, reason) => h().onStopped?.(id, reason),
    refresh: id => h().refresh?.(id),
    onOverQuota: (id, usage) => h().onOverQuota?.(id, usage),
    onTainted: id => h().onTainted?.(id),
    ...opts,
    namePrefix: evalContainerPrefix(scope.worldId),
    offline: true,
    labels: evalSandboxLabels(scope),
    settings: { ...opts.settings, workspacesDir: evalWorkspacesDir(scope.worldId, opts.settings?.workspacesDir) }
  })
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
  /** Every minute, before the idle stop (final review I2: tear down finished workstreams' workspaces). */
  onTick?: () => Promise<void> | void
  /** Final review I6: the sandbox's health — at boot (Docker down, or after the reconcile) and then
   *  every healthMs (default 5 min). The worker puts it on its heartbeat. */
  onHealth?: (h: SandboxHealth) => void
  healthMs?: number
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
  let lastHealth = 0
  let lastReason: string | null | undefined
  const report = (h: SandboxHealth, how: { quiet?: boolean } = {}) => {
    const reason = h.ok ? null : h.reason
    if (reason !== lastReason && !how.quiet) log[h.ok ? 'info' : 'warn'](h.ok ? '[sandbox] preflight ok' : `[sandbox] unavailable: ${reason}`)
    lastReason = reason
    try { o.onHealth?.(h) } catch (err) { log.warn('[sandbox] health report failed:', (err as Error).message) }
  }
  const step = async () => {
    if (!reconciled) {
      if (!await m.available()) {
        if (!warned) { warned = true; log.warn('[sandbox] Docker is not available — workspace tools are disabled until it is') }
        report({ ok: false, reason: 'Docker is not running on this host', checkedAt: new Date().toISOString() }, { quiet: true })
        return
      }
      const r = await m.reconcile()
      reconciled = true
      log.info(`[sandbox] reconciled: ${r.removed.length} orphan container(s) removed, ${r.repaired.length} row(s) repaired`)
      await o.afterReconcile?.()
    }
    if (Date.now() - lastHealth >= (o.healthMs ?? 5 * 60_000)) {
      lastHealth = Date.now()
      report(await m.health())
    }
    if (stopped) return
    if (m.isDiskLow()) return
    try { await o.onTick?.() } catch (err) { log.warn('[sandbox] tick hook failed:', (err as Error).message) }
    if (stopped) return
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
