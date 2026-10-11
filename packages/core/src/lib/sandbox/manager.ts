// Cycle 82 (spec §2): the sandbox manager — one Docker container per workspace, worker-side only.
//
//   ensureContainer(id) → create/start `mymind-ws-<id>` (label mymind.workspace=<id>); exactly one
//                         even under concurrency (in-process lock + docker's unique container name).
//   exec(id, cmd)       → `docker exec` (timeout default 120s / max 600s, 64 KB tail-kept output,
//                         env HOME/PATH/LANG + opted-in secrets). Tainted → a one-off
//                         `docker run --rm --network none` with the same mount + limits, no secrets.
//   idleStop / quotaTick / reconcile / sweep — the worker's housekeeping (startSandboxHousekeeping).
//
// Path safety: the host only ever creates/removes `<workspacesDir>/<uuid>`; everything that reads or
// writes workspace FILES runs inside a container, so a symlink in the workspace can't reach the host.
// Preflight fails closed: no Docker / no image / (Linux) firewall not matching network.ts → a
// SandboxUnavailableError the workspace tools surface as-is.
import { execFile } from 'node:child_process'
import { chown, mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  LABEL_TAINTED, LABEL_TEST, LABEL_WORKSPACE, SANDBOX_UID, SandboxUnavailableError, TIMEOUT_EXIT_CODES,
  createArgs, createDockerCli, dockerAvailable, ensureNetwork, execArgs, killExecArgs, taintedRunArgs, verifyNetworkIsolation,
  type DockerRunner
} from './docker'
import { DEFAULT_SANDBOX_DNS } from './network'
import { DEFAULT_QUOTA_BYTES, MEASURE_COMMAND, SandboxQuotaError, overQuota, parseDu } from './quota'
import { dbWorkspaceStore, type WorkspaceRow, type WorkspaceStore } from './store'

export { SandboxUnavailableError } from './docker'
export { SandboxQuotaError } from './quota'

export interface SandboxSettings {
  image: string
  workspacesDir: string
  /** Resolvers for the sandbox network ([] = Docker's default). */
  dns: string[]
  /** 'enforce': refuse to run unless the live iptables rules match network.ts (Linux). */
  firewall: 'enforce' | 'off'
  idleMs: number
  quotaBytes: number
  defaultTimeoutSec: number
  maxTimeoutSec: number
  outputCapBytes: number
}

/** Settings from the worker's env. Production on Linux always enforces the firewall. */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SandboxSettings {
  const prod = env.NODE_ENV === 'production'
  const linux = platform === 'linux'
  const firewall: SandboxSettings['firewall'] = linux && (prod || env.SANDBOX_FIREWALL !== 'off') ? 'enforce' : 'off'
  return {
    image: env.SANDBOX_IMAGE || 'mymind-sandbox:current',
    workspacesDir: path.resolve(env.SANDBOX_WORKSPACES_DIR || (prod ? '/opt/mymind/.workspaces' : '.data/workspaces')),
    // Docker Desktop drops outbound UDP to public resolvers, so dev on macOS keeps Docker's own.
    dns: env.SANDBOX_DNS !== undefined ? env.SANDBOX_DNS.split(',').map(s => s.trim()).filter(Boolean) : linux ? [...DEFAULT_SANDBOX_DNS] : [],
    firewall,
    idleMs: 15 * 60_000,
    quotaBytes: DEFAULT_QUOTA_BYTES,
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
  aborted: boolean
  truncated: boolean
  tainted: boolean
}

export interface ExecOptions {
  timeoutSec?: number
  signal?: AbortSignal
  /** Opted-in sandbox secrets (spec §6) — never passed to tainted runs. */
  secrets?: Record<string, string>
  /** The run has read untrusted content: no network (spec D5). */
  tainted?: boolean
}

export interface SandboxManagerOptions {
  docker?: DockerRunner
  store?: WorkspaceStore
  settings?: Partial<SandboxSettings>
  /** Labels stamped on every container this manager creates AND the reconcile scope (tests). */
  labels?: Record<string, string>
  /** `iptables -S` on the host (firewall verification). */
  iptablesS?: () => Promise<string>
  /** True while a workspace must not be idle-stopped (background shells — Task 2). */
  isBusy?: (workspaceId: string) => boolean
  /** Called when a workspace is measured over quota (Task 2 kills its background shells). */
  onOverQuota?: (workspaceId: string, bytesUsed: number) => Promise<void> | void
  log?: Pick<Console, 'info' | 'warn' | 'error'>
  now?: () => number
  uid?: number | undefined
  platform?: NodeJS.Platform
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PREFLIGHT_TTL_MS = 60_000

export function containerName(workspaceId: string): string {
  return `mymind-ws-${workspaceId}`
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

export function createSandboxManager(opts: SandboxManagerOptions = {}) {
  const docker = opts.docker ?? createDockerCli()
  const store = opts.store ?? dbWorkspaceStore
  const s: SandboxSettings = { ...sandboxSettings(), ...opts.settings }
  const labels = opts.labels ?? {}
  const log = opts.log ?? console
  const now = opts.now ?? Date.now
  const uid = 'uid' in opts ? opts.uid : process.getuid?.()
  const platform = opts.platform ?? process.platform
  const locks = new Map<string, Promise<unknown>>()
  const measuredAt = new Map<string, number>()
  let preflightOk: { at: number; network: boolean } | null = null
  let imageId: string | null = null

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
    await liveRow(id)
    await preflight(true)
    const name = containerName(id)
    for (let attempt = 0; attempt < 3; attempt++) {
      let c = await inspect(name)
      if (c && imageId && c.Image !== imageId) {
        log.info(`[sandbox] workspace ${id}: container built from an older image — recreating (files kept)`)
        await docker(['rm', '-f', c.Id], { timeoutMs: 30_000 })
        c = null
      }
      if (!c) {
        const dir = await ensureDir(id)
        const r = await docker(createArgs({ name, image: s.image, workspaceId: id, hostDir: dir, labels, dns: s.dns }), { timeoutMs: 60_000 })
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

  function timeoutOf(sec?: number): number {
    const t = Math.floor(sec ?? s.defaultTimeoutSec)
    if (!Number.isFinite(t) || t < 1) return s.defaultTimeoutSec
    return Math.min(t, s.maxTimeoutSec)
  }

  function result(r: Awaited<ReturnType<DockerRunner>>, tainted: boolean, aborted: boolean): SandboxExecResult {
    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut || (r.code !== null && TIMEOUT_EXIT_CODES.has(r.code) && !aborted),
      aborted: aborted || r.aborted,
      truncated: r.truncated,
      tainted
    }
  }

  /** Kill an exec's process group; when even that can't run (pids exhausted) restart the container. */
  async function hardKill(name: string, execId: string): Promise<void> {
    const k = await docker(killExecArgs(name, execId), { timeoutMs: 15_000 })
    if (k.code !== 0) {
      log.warn(`[sandbox] could not kill exec ${execId} in ${name} (${k.stderr.trim()}) — restarting the container`)
      await docker(['restart', '-t', '0', name], { timeoutMs: 60_000 })
    }
  }

  async function exec(id: string, command: string, o: ExecOptions = {}): Promise<SandboxExecResult> {
    const timeoutSec = timeoutOf(o.timeoutSec)
    const execId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    // Host-side backstop: the in-container `timeout` should always win; this only catches a hung CLI.
    const hostTimeoutMs = (timeoutSec + 15) * 1000
    if (o.tainted) {
      await liveRow(id)
      await preflight(false)
      const dir = await ensureDir(id)
      const name = `mymind-wst-${id.slice(0, 8)}-${execId}`
      await store.touch(id)
      let aborted = false
      const onAbort = () => { aborted = true; void docker(['kill', name], { timeoutMs: 15_000 }) }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (o.signal?.aborted) return result({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }, true, true)
        const r = await docker(taintedRunArgs({ name, image: s.image, workspaceId: id, hostDir: dir, labels, command, execId, timeoutSec }),
          { timeoutMs: hostTimeoutMs, capBytes: s.outputCapBytes })
        if (r.timedOut) await docker(['rm', '-f', name], { timeoutMs: 15_000 })
        return result(r, true, aborted)
      } finally { o.signal?.removeEventListener('abort', onAbort) }
    }
    const secrets = o.secrets ?? {}
    for (const k of Object.keys(secrets)) {
      if (!ENV_NAME.test(k) || ['HOME', 'PATH', 'LANG'].includes(k)) throw new Error(`invalid sandbox secret name ${k}`)
    }
    const { name } = await ensureContainer(id)
    await store.touch(id)
    let aborted = false
    const onAbort = () => { aborted = true; void hardKill(name, execId) }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (o.signal?.aborted) return result({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }, false, true)
      const r = await docker(execArgs({ container: name, command, execId, timeoutSec, secretNames: Object.keys(secrets) }),
        { timeoutMs: hostTimeoutMs, env: secrets, capBytes: s.outputCapBytes })
      if (r.timedOut) await hardKill(name, execId)
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

  async function measure(id: string): Promise<number | null> {
    const r = await docker(['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, containerName(id), '/bin/sh', '-c', MEASURE_COMMAND], { timeoutMs: 120_000 })
    const bytes = r.code === 0 ? parseDu(r.stdout) : null
    if (bytes !== null) {
      await store.setBytes(id, bytes)
      measuredAt.set(id, now())
    }
    return bytes
  }

  /** Before a write: refuse when over quota (measured within the last minute, else now). */
  async function checkQuota(id: string): Promise<void> {
    const row = await liveRow(id)
    let bytes = row.bytesUsed
    const at = measuredAt.get(id)
    if (at === undefined || now() - at >= 60_000) {
      await ensureContainer(id)
      bytes = (await measure(id)) ?? bytes
    }
    if (overQuota(bytes, s.quotaBytes)) throw new SandboxQuotaError(bytes, s.quotaBytes)
  }

  /** Every 60s: measure running workspaces; over quota → onOverQuota (kills background shells). */
  async function quotaTick(): Promise<Array<{ id: string; bytes: number; over: boolean }>> {
    const out: Array<{ id: string; bytes: number; over: boolean }> = []
    for (const row of await store.listRunning()) {
      try {
        const bytes = await measure(row.id)
        if (bytes === null) continue
        const over = overQuota(bytes, s.quotaBytes)
        out.push({ id: row.id, bytes, over })
        if (over) {
          log.warn(`[sandbox] workspace ${row.id} over quota (${bytes} bytes)`)
          await opts.onOverQuota?.(row.id, bytes)
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
      if (opts.isBusy?.(row.id)) continue
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

  /**
   * Worker boot: remove labelled containers that are orphans (no live row, tainted leftovers, wrong
   * name, older image) and fix rows whose container is gone. Only containers in this manager's
   * scope are removed; rows are repaired from facts (does `mymind-ws-<id>` exist?).
   */
  async function reconcile(): Promise<{ removed: string[]; repaired: string[] }> {
    const removed: string[] = []
    const repaired: string[] = []
    const ls = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_WORKSPACE}`], { timeoutMs: 30_000 })
    if (ls.code !== 0) throw new SandboxUnavailableError(`docker ps failed: ${ls.stderr.trim()}`)
    const ids = ls.stdout.split('\n').map(x => x.trim()).filter(Boolean)
    const all: Inspected[] = []
    if (ids.length) {
      const r = await docker(['container', 'inspect', ...ids], { timeoutMs: 60_000 })
      // A container removed between ps and inspect makes inspect exit 1 but still print the rest.
      try { all.push(...JSON.parse(r.stdout || '[]') as Inspected[]) } catch { /* nothing parsable */ }
    }
    const img = await docker(['image', 'inspect', '--format', '{{.Id}}', s.image], { timeoutMs: 15_000 })
    const currentImage = img.code === 0 ? img.stdout.trim() : null
    const keep = new Map<string, Inspected>()
    for (const c of all) {
      if (!inScope(c)) { const wid = c.Config.Labels?.[LABEL_WORKSPACE]; if (wid && c.Name === `/${containerName(wid)}`) keep.set(wid, c); continue }
      const wid = c.Config.Labels?.[LABEL_WORKSPACE] ?? ''
      const row = UUID.test(wid) ? await store.get(wid) : null
      const orphan = !row || row.deletedAt !== null
        || c.Config.Labels?.[LABEL_TAINTED] !== undefined
        || c.Name !== `/${containerName(wid)}`
        || (currentImage !== null && c.Image !== currentImage)
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
    stopContainer,
    removeContainer,
    destroyWorkspace,
    checkQuota,
    measure,
    quotaTick,
    idleStop,
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

/**
 * Worker housekeeping (spec §2): reconcile once at boot, then every minute idle-stop + quota, and
 * the deletion sweep daily. Never throws; with no Docker it logs once and keeps checking quietly.
 * Ticks touch Docker only when the DB has running workspaces.
 */
export function startSandboxHousekeeping(m: SandboxManager = sandboxManager(), o: { tickMs?: number; sweepMs?: number; log?: Pick<Console, 'info' | 'warn' | 'error'> } = {}): () => void {
  const log = o.log ?? console
  let stopped = false
  let reconciled = false
  let warned = false
  let lastSweep = 0
  let running: Promise<void> | null = null
  const step = async () => {
    if (!reconciled) {
      if (!await m.available()) {
        if (!warned) { warned = true; log.warn('[sandbox] Docker is not available — workspace tools are disabled until it is') }
        return
      }
      const r = await m.reconcile()
      reconciled = true
      log.info(`[sandbox] reconciled: ${r.removed.length} orphan container(s) removed, ${r.repaired.length} row(s) repaired`)
    }
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
  tick()
  const timer = setInterval(tick, o.tickMs ?? 60_000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
