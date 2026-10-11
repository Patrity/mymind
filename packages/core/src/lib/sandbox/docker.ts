// Cycle 82 (spec §2): the docker CLI boundary — every argv the sandbox runs is BUILT here (pure,
// unit-tested flag for flag) and executed by `dockerCli` (spawn of the `docker` binary with a
// minimal env: the worker's own secrets never reach the CLI, let alone the sandbox).
// The worker is the only caller (root in the LXC on prod; Docker Desktop/colima in dev).
import { spawn } from 'node:child_process'
import { DEFAULT_SANDBOX_DNS, SANDBOX_NETWORK, checkIsolation, networkCreateArgs, type IsolationCheck } from './network'

export const SANDBOX_UID = 10001
export const WORKSPACE_MOUNT = '/workspace'
export const LABEL_WORKSPACE = 'mymind.workspace'
export const LABEL_TAINTED = 'mymind.tainted'
export const LABEL_TEST = 'mymind.test'
export const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** The base env of every sandbox process — nothing else unless a secret is opted in (spec §6). */
export const SANDBOX_BASE_ENV: Readonly<Record<string, string>> = { HOME: '/home/agent', PATH: SANDBOX_PATH, LANG: 'C.UTF-8' }

export class SandboxUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxUnavailableError' }
}

export interface SandboxLimits {
  pids: number
  memory: string
  cpus: string
}
/** Spec §2 — exact. */
export const SANDBOX_LIMITS: SandboxLimits = { pids: 512, memory: '2g', cpus: '1.5' }

export interface ContainerSpec {
  name: string
  image: string
  workspaceId: string
  /** Absolute host dir bind-mounted at /workspace (the ONLY mount besides the two tmpfs). */
  hostDir: string
  /** Extra labels (tests: mymind.test=<runId>). */
  labels?: Record<string, string>
  dns?: readonly string[]
  network?: string
  limits?: SandboxLimits
}

/** Flags shared by the long-lived workspace container and the one-off tainted container. */
function isolationFlags(spec: ContainerSpec): string[] {
  const l = spec.limits ?? SANDBOX_LIMITS
  const labels = { [LABEL_WORKSPACE]: spec.workspaceId, ...spec.labels }
  return [
    '--user', `${SANDBOX_UID}:${SANDBOX_UID}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(l.pids),
    '--memory', l.memory,
    '--memory-swap', l.memory, // = memory: no swap on top of the limit
    '--cpus', l.cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
    '--tmpfs', `/home/agent:rw,nosuid,nodev,size=512m,uid=${SANDBOX_UID},gid=${SANDBOX_UID},mode=0700`,
    '--mount', `type=bind,src=${spec.hostDir},dst=${WORKSPACE_MOUNT}`,
    '--workdir', WORKSPACE_MOUNT,
    '--hostname', 'sandbox',
    '--init', // reap zombies of background shells
    // Fresh env: these replace nothing the image doesn't already set (PATH/LANG only).
    ...Object.entries(SANDBOX_BASE_ENV).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`])
  ]
}

/** `docker create` for a workspace's long-lived container (idles in `sleep infinity`). */
export function createArgs(spec: ContainerSpec): string[] {
  return [
    'create', '--name', spec.name,
    ...isolationFlags(spec),
    '--network', spec.network ?? SANDBOX_NETWORK,
    ...(spec.dns ?? DEFAULT_SANDBOX_DNS).flatMap(d => ['--dns', d]),
    '--restart', 'no',
    spec.image, 'sleep', 'infinity'
  ]
}

/**
 * The in-container wrapper every command runs under. coreutils `timeout` bounds it and, being
 * started in the background, leads its OWN process group (it setpgid()s); its pid (= the group id)
 * is recorded so an abort can kill the group from outside (`killExecArgs`). `timeout` alone is not
 * enough: it SIGTERMs the group and only escalates if the top command survives, so anything that
 * ignores/blocks TERM (a fork bomb mid-retry) would outlive it — on a timeout the wrapper therefore
 * SIGKILLs the whole group until it is empty, using shell builtins only (no fork needed at the pids
 * limit). Positional args: `$1` = exec id, `$2` = seconds, `$3` = the command (never interpolated).
 */
export const EXEC_WRAPPER = 'mkdir -p /tmp/.mm-exec; timeout -k 2 "$2" /bin/bash -c "$3" & p=$!; echo "$p" > "/tmp/.mm-exec/$1"; wait "$p"; c=$?; '
  + 'case "$c" in 124|137) i=0; while kill -9 -"$p" 2>/dev/null && [ "$i" -lt 10000 ]; do i=$((i+1)); done;; esac; rm -f "/tmp/.mm-exec/$1"; exit "$c"'

/** Exit codes `timeout` reports when it had to stop the command. */
export const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137])

const EXEC_ID = /^[a-z0-9-]{1,64}$/

/** Kill an in-flight exec's whole process group (abort). Builtins only (dash: no `--`, no `$(…)`). */
export function killExecArgs(container: string, execId: string): string[] {
  if (!EXEC_ID.test(execId)) throw new Error(`bad exec id ${execId}`)
  return ['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, container, '/bin/sh', '-c',
    `read p < /tmp/.mm-exec/${execId} 2>/dev/null || exit 0; i=0; while kill -9 -"$p" 2>/dev/null && [ "$i" -lt 10000 ]; do i=$((i+1)); done; exit 0`]
}

export interface ExecSpec {
  container: string
  command: string
  execId: string
  timeoutSec: number
  /** Opted-in secret NAMES: passed as `--env NAME` (value taken from the docker CLI's env, never argv). */
  secretNames?: string[]
}

/** `docker exec` into a workspace container. */
export function execArgs(spec: ExecSpec): string[] {
  if (!EXEC_ID.test(spec.execId)) throw new Error(`bad exec id ${spec.execId}`)
  return [
    'exec', '-i',
    '--user', `${SANDBOX_UID}:${SANDBOX_UID}`,
    '--workdir', WORKSPACE_MOUNT,
    ...Object.entries(SANDBOX_BASE_ENV).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...(spec.secretNames ?? []).flatMap(n => ['--env', n]),
    spec.container,
    '/bin/sh', '-c', EXEC_WRAPPER, 'mm-exec', spec.execId, String(spec.timeoutSec), spec.command
  ]
}

/** Spec §2 tainted runs: a one-off `docker run --rm --network none`, same mount + limits. No secrets. */
export function taintedRunArgs(spec: ContainerSpec & { command: string; execId: string; timeoutSec: number }): string[] {
  if (!EXEC_ID.test(spec.execId)) throw new Error(`bad exec id ${spec.execId}`)
  return [
    'run', '--rm', '-i', '--name', spec.name,
    ...isolationFlags({ ...spec, labels: { [LABEL_TAINTED]: '1', ...spec.labels } }),
    '--network', 'none',
    spec.image,
    '/bin/sh', '-c', EXEC_WRAPPER, 'mm-exec', spec.execId, String(spec.timeoutSec), spec.command
  ]
}

// ── CLI runner ─────────────────────────────────────────────────────────────────────────────────

export interface DockerResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** True when stdout/stderr were longer than the cap (the TAIL is kept). */
  truncated: boolean
}

export interface DockerRunOpts {
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra env for the docker CLI process (opted-in secret values for `--env NAME`). */
  env?: Record<string, string>
  /** Per-stream cap; the tail is kept. Default 16 MB (docker's own JSON); command output passes 64 KB. */
  capBytes?: number
  input?: string
}

export type DockerRunner = (args: string[], opts?: DockerRunOpts) => Promise<DockerResult>

/** The env the docker CLI itself gets: what it needs to find the daemon, nothing of the app's. */
export function dockerCliEnv(from: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: from.PATH || SANDBOX_PATH }
  for (const k of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    const v = from[k]
    if (v) env[k] = v
  }
  return { ...env, ...extra }
}

/** Keep the last `cap` bytes of a stream. */
export class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(private cap: number) {}
  push(b: Buffer): void {
    this.chunks.push(b)
    this.size += b.length
    while (this.size > this.cap && this.chunks.length) {
      const first = this.chunks[0]!
      const over = this.size - this.cap
      this.truncated = true
      if (first.length <= over) { this.chunks.shift(); this.size -= first.length }
      else { this.chunks[0] = first.subarray(over); this.size -= over }
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export function createDockerCli(bin = 'docker', baseEnv: NodeJS.ProcessEnv = process.env): DockerRunner {
  return (args, opts = {}) => new Promise<DockerResult>((resolve) => {
    const cap = opts.capBytes ?? 16 * 1024 * 1024
    const out = new TailBuffer(cap)
    const err = new TailBuffer(cap)
    let timedOut = false
    let aborted = false
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }); return
    }
    const child = spawn(bin, args, { env: dockerCliEnv(baseEnv, opts.env), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeoutMs) : null
    const onAbort = () => { aborted = true; child.kill('SIGKILL') }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null, spawnErr?: Error) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout: out.toString(),
        stderr: spawnErr ? `${spawnErr.message}` : err.toString(),
        timedOut, aborted, truncated: out.truncated || err.truncated
      })
    }
    child.on('error', e => done(null, e))
    child.on('close', code => done(code))
  })
}

/** True when the docker daemon answers. */
export async function dockerAvailable(run: DockerRunner): Promise<boolean> {
  const r = await run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 })
  return r.code === 0 && r.stdout.trim().length > 0
}

/** Create the sandbox network unless it exists. */
export async function ensureNetwork(run: DockerRunner): Promise<void> {
  const r = await run(['network', 'inspect', SANDBOX_NETWORK, '--format', '{{.Id}}'], { timeoutMs: 15_000 })
  if (r.code === 0) return
  const c = await run(networkCreateArgs(), { timeoutMs: 30_000 })
  if (c.code !== 0 && !/already exists/i.test(c.stderr)) throw new SandboxUnavailableError(`could not create the ${SANDBOX_NETWORK} network: ${c.stderr.trim()}`)
}

/**
 * Fail-closed firewall check (Linux hosts): the live iptables rules + network options match the
 * plan in network.ts. `iptables` runs on the HOST (the worker is root in the LXC).
 */
export async function verifyNetworkIsolation(run: DockerRunner, iptablesS: () => Promise<string>): Promise<IsolationCheck> {
  const r = await run(['network', 'inspect', SANDBOX_NETWORK, '--format', '{{json .}}'], { timeoutMs: 15_000 })
  let net: Parameters<typeof checkIsolation>[1] = null
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.stdout) as { Options?: Record<string, string>; EnableIPv6?: boolean; IPAM?: { Config?: Array<{ Subnet?: string }> } }
      net = {
        bridgeName: j.Options?.['com.docker.network.bridge.name'],
        icc: j.Options?.['com.docker.network.bridge.enable_icc'],
        subnet: j.IPAM?.Config?.[0]?.Subnet,
        ipv6: j.EnableIPv6 === true
      }
    } catch { net = null }
  }
  let rules = ''
  try { rules = await iptablesS() } catch (e) { return { ok: false, problems: [`iptables -S failed: ${(e as Error).message}`] } }
  return checkIsolation(rules, net)
}
