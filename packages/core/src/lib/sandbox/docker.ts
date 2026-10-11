// Cycle 82 (spec §2): the docker CLI boundary — every argv the sandbox runs is BUILT here (pure,
// unit-tested flag for flag) and executed by `dockerCli` (spawn of the `docker` binary with a
// minimal env: the worker's own secrets never reach the CLI, let alone the sandbox).
// The worker is the only caller (root in the LXC on prod; Docker Desktop/colima in dev).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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

/** Final review M5: an API-token read found the sandbox stopped (or tainted) — reads never start one. */
export class SandboxStoppedError extends SandboxUnavailableError {
  constructor() { super('sandbox stopped — open it in the app'); this.name = 'SandboxStoppedError' }
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

/** RLIMIT_FSIZE for every sandbox process (review I2): no single file can outgrow 1 GiB. */
export const SANDBOX_FSIZE_BYTES = 1024 ** 3
export const LABEL_FLAGS = 'mymind.flags'

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
    '--ulimit', `fsize=${SANDBOX_FSIZE_BYTES}:${SANDBOX_FSIZE_BYTES}`,
    // The firewall is IPv4-only: no IPv6 in the sandbox at all (review M7).
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
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

function baseCreateArgs(spec: ContainerSpec): string[] {
  return [
    'create', '--name', spec.name,
    ...isolationFlags(spec),
    '--network', spec.network ?? SANDBOX_NETWORK,
    ...(spec.dns ?? DEFAULT_SANDBOX_DNS).flatMap(d => ['--dns', d]),
    '--restart', 'no'
  ]
}

/**
 * Hash of every isolation-relevant flag of a workspace container (not its name or extra labels;
 * the image is compared separately). Stamped as `mymind.flags`; a container whose label differs was
 * created under an older policy and is recreated (files kept) — review M6.
 */
export function flagsHash(spec: ContainerSpec): string {
  return createHash('sha256').update(JSON.stringify(baseCreateArgs({ ...spec, name: '', labels: {} }))).digest('hex').slice(0, 16)
}

/** `docker create` for a workspace's long-lived container (idles in `sleep infinity`). */
export function createArgs(spec: ContainerSpec): string[] {
  return [...baseCreateArgs(spec), '--label', `${LABEL_FLAGS}=${flagsHash(spec)}`, spec.image, 'sleep', 'infinity']
}

/** Reads the probe's own cgroup limits (v2 files, v1 fallback). */
export const LIMITS_PROBE_SCRIPT = [
  'if [ -r /sys/fs/cgroup/memory.max ]; then m=$(cat /sys/fs/cgroup/memory.max); else m=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo none); fi',
  'if [ -r /sys/fs/cgroup/pids.max ]; then p=$(cat /sys/fs/cgroup/pids.max); else p=$(cat /sys/fs/cgroup/pids/pids.max 2>/dev/null || echo none); fi',
  'echo "memory=$m pids=$p"'
].join('\n')

/** Final review I4: `docker create` for the limits probe — every isolation flag of a sandbox, no
 *  network (the firewall is not what it checks), prints its own cgroup limits. */
export function limitsProbeArgs(spec: ContainerSpec): string[] {
  return ['create', '--name', spec.name, ...isolationFlags(spec), '--network', 'none', '--restart', 'no', spec.image, '/bin/sh', '-c', LIMITS_PROBE_SCRIPT]
}

function memoryBytes(m: string): number {
  const x = m.trim().toLowerCase().match(/^(\d+)([kmg]?)$/)
  if (!x) return NaN
  return Number(x[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[x[2]!]!
}

/**
 * What is wrong with the probe's limits ([] = enforced): HostConfig must hold the spec values (a
 * discarded flag reads 0) AND the cgroup the container really runs in must say the same (a
 * controller that is not delegated reads `max` / is missing).
 */
export function limitsProblems(hostConfig: string, probe: string, limits: SandboxLimits = SANDBOX_LIMITS): string[] {
  const problems: string[] = []
  const wantMem = memoryBytes(limits.memory)
  const [mem, pids] = hostConfig.trim().split(/\s+/)
  if (Number(mem) !== wantMem) problems.push(`HostConfig.Memory is ${mem || 'unknown'} (want ${wantMem})`)
  if (Number(pids) !== limits.pids) problems.push(`HostConfig.PidsLimit is ${pids || 'unknown'} (want ${limits.pids})`)
  const m = probe.match(/memory=(\S+) pids=(\S+)/)
  if (!m) problems.push(`the probe did not report its cgroup limits (${probe.trim().slice(0, 120) || 'no output'})`)
  else {
    if (Number(m[1]) !== wantMem) problems.push(`the container's cgroup memory limit is ${m[1]} (want ${wantMem}) — the memory controller is not enforced`)
    if (Number(m[2]) !== limits.pids) problems.push(`the container's cgroup pids limit is ${m[2]} (want ${limits.pids}) — the pids controller is not enforced`)
  }
  return problems
}

/**
 * The in-container wrapper every command runs under (dash). Positional args: `$1` = exec id,
 * `$2` = seconds, `$3` = the command (never interpolated).
 *  - coreutils `timeout`, started in the background, leads its OWN process group; its pid (= the
 *    group id) goes to /tmp/.mm-exec/<id> so an abort can kill the group from outside.
 *  - Abort before the pid file exists (review M5): the abort first drops a tombstone
 *    `<id>.abort`, then reads the pid file; the wrapper first writes the pid file, then checks the
 *    tombstone — whichever comes second does the kill, so an early abort is never lost.
 *  - `timeout` alone does not stop a fork bomb (it SIGTERMs, and escalates only if the top
 *    command survives), so on 124/137 the wrapper SIGKILLs the group until it is empty (builtins
 *    only: no fork needed at the pids limit).
 *  - On 124/137 it reports WHY on stderr's last line (`__mm_status__:oom|timeout|aborted|killed`,
 *    stripped by the manager — review M10): an OOM kill (the cgroup's oom_kill counter moved) is
 *    not a timeout.
 */
export const EXEC_WRAPPER = [
  // stdin (Task 2: file contents for write_file/edit_file arrive on it, never in argv — a single
  // argv string is capped at 128 KB and is visible in /proc): a non-interactive shell points an
  // async list's stdin at /dev/null BEFORE its own redirections, so it is kept on fd 3 and handed
  // back explicitly below.
  'exec 3<&0',
  'd=/tmp/.mm-exec; mkdir -p "$d"',
  'o=$(sed -n "s/^oom_kill //p" /sys/fs/cgroup/memory.events 2>/dev/null); s=$(date +%s)',
  'timeout -k 2 "$2" /bin/bash -c "$3" 0<&3 3<&- & p=$!',
  'exec 3<&-',
  'echo "$p" > "$d/$1"',
  // The group AND the pid: right after `&`, timeout may not have setpgid()ed yet (no group to kill,
  // but also no children yet — killing the pid is enough then).
  '[ -e "$d/$1.abort" ] && { kill -9 -"$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; }',
  'wait "$p"; c=$?',
  'case "$c" in 124|137)',
  '  i=0; while kill -9 -"$p" 2>/dev/null && [ "$i" -lt 10000 ]; do i=$((i+1)); done',
  '  n=$(sed -n "s/^oom_kill //p" /sys/fs/cgroup/memory.events 2>/dev/null)',
  '  if [ "${n:-0}" -gt "${o:-0}" ]; then st=oom',
  '  elif [ -e "$d/$1.abort" ]; then st=aborted',
  '  elif [ "$c" = 124 ] || [ $(( $(date +%s) - s )) -ge "$2" ]; then st=timeout',
  '  else st=killed; fi',
  "  printf '\\n__mm_status__:%s\\n' \"$st\" >&2;;",
  'esac',
  'rm -f "$d/$1" "$d/$1.abort"; exit "$c"'
].join('\n')

export type ExecStatus = 'oom' | 'timeout' | 'aborted' | 'killed'
const STATUS_RE = /\n?__mm_status__:(oom|timeout|aborted|killed)\n?$/

/** Split the wrapper's trailing status marker off stderr. */
export function parseExecStatus(stderr: string): { stderr: string; status: ExecStatus | null } {
  const m = stderr.match(STATUS_RE)
  if (!m) return { stderr, status: null }
  return { stderr: stderr.slice(0, m.index), status: m[1] as ExecStatus }
}

const EXEC_ID = /^[a-z0-9-]{1,64}$/

/** Kill an in-flight exec's whole process group (abort). Builtins only (dash: no `--`, no `$(…)`). */
export function killExecArgs(container: string, execId: string): string[] {
  if (!EXEC_ID.test(execId)) throw new Error(`bad exec id ${execId}`)
  return ['exec', '--user', `${SANDBOX_UID}:${SANDBOX_UID}`, container, '/bin/sh', '-c',
    `d=/tmp/.mm-exec; mkdir -p "$d"; : > "$d/${execId}.abort"; read p < "$d/${execId}" 2>/dev/null || exit 0; kill -9 "$p" 2>/dev/null; i=0; while kill -9 -"$p" 2>/dev/null && [ "$i" -lt 10000 ]; do i=$((i+1)); done; exit 0`]
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Names the docker CLI (a Go program running as root on the host) or its dynamic loader reads —
 *  a secret may never be called this, since secret values travel in the CLI's env (review M4). */
const SECRET_DENY = /^(DOCKER_.*|BUILDKIT_.*|COMPOSE_.*|LD_.*|DYLD_.*|GCONV_PATH|NLSPATH|LOCPATH|MALLOC_.*|GODEBUG|GOGC|GOMAXPROCS|GOMEMLIMIT|GOTRACEBACK|GORACE|SSL_CERT_.*|SSLKEYLOGFILE|(HTTPS?|FTP|ALL|NO)_PROXY|TMPDIR|TMP|TEMP|XDG_.*|HOME|PATH|LANG|LANGUAGE|LC_.*|HOSTNAME|TERM|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|PS4|NOTARY_.*)$/i

/** Throws unless `name` is a safe sandbox secret name. */
export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name) || SECRET_DENY.test(name)) throw new Error(`invalid sandbox secret name ${name} (reserved or not an identifier)`)
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
  const base: Record<string, string> = { PATH: from.PATH || SANDBOX_PATH }
  for (const k of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    const v = from[k]
    if (v) base[k] = v
  }
  // Secret values (`extra`) can never override or add a name the CLI itself reads (review M4).
  const secrets = Object.fromEntries(Object.entries(extra).filter(([k]) => { try { assertSecretName(k); return true } catch { return false } }))
  return { ...secrets, ...base }
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
  if (net) {
    const info = await run(['info', '--format', '{{json .FirewallBackend}}'], { timeoutMs: 15_000 })
    if (info.code === 0) {
      try {
        const fb = JSON.parse(info.stdout) as { Driver?: string } | null
        if (fb?.Driver) net.firewallDriver = fb.Driver
      } catch { /* older daemon: no FirewallBackend — the chain-visibility check still applies */ }
    }
  }
  let rules = ''
  try { rules = await iptablesS() } catch (e) { return { ok: false, problems: [`iptables -S failed: ${(e as Error).message}`] } }
  return checkIsolation(rules, net)
}
