// Cycle 86 (spec §3): the one place a workspace command becomes a host process.
//
//   `bash -c <command>` in its OWN process group (spawn `detached`: setsid), cwd = the workspace dir,
//   the env the manager built (never the worker's). Confined: wrapped in `sandbox-exec -p <profile>`
//   (profile.ts), which execs bash in place — same pid, same group.
//   Timeout: SIGTERM to the group, SIGKILL after 2 s, then SIGKILL until the group is empty (a fork
//   bomb outlives one kill). Abort: SIGKILL the group at once, the same way.
//   Output: the TAIL of each stream is kept (capBytes); `truncated` says something was cut.
//   `reapGroup` (confined commands): whatever the command left running in its group dies with it —
//   a tainted run gets no background work. Clean commands keep `cmd &` children (Bridget's choice).
//
// Eval worlds (D7, the fence the docker allow-list used to be): inside an eval scope EVERY spawn is
// checked here, below the manager, before anything runs — confined, cwd / writes / TMPDIR / HOME
// inside the world's own registered scratch dir, reads under the user's home denied except that dir,
// and an env with no key beyond EVAL_ENV_KEYS (no secrets). Anything else is refused.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { currentEvalScope, type EvalScope } from '../../eval/context'
import { SandboxUnavailableError } from '../errors'
import { EVAL_ENV_KEYS } from './env'
import { confinementProfile, SANDBOX_EXEC, type Confinement } from './profile'

export interface HostCommand {
  command: string
  /** Absolute, normalised (the manager passes realpaths). */
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  capBytes: number
  signal?: AbortSignal
  /** Fed to stdin (file contents — never in argv). */
  input?: string
  /** Run under sandbox-exec with this confinement. */
  confine?: Confinement
  /** Kill whatever is left in the command's process group once it exits. */
  reapGroup?: boolean
}

export interface HostResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** True when stdout/stderr were longer than the cap (the TAIL is kept). */
  truncated: boolean
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Signal a whole process group; false once it is gone. */
export function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false
  try { process.kill(-pgid, sig); return true } catch { return false }
}

/** SIGKILL a process group until nothing is left in it (bounded: ~2 s). */
export async function killGroup(pgid: number): Promise<void> {
  for (let i = 0; i < 200 && signalGroup(pgid, 'SIGKILL'); i++) await sleep(10)
}

// ── eval worlds ────────────────────────────────────────────────────────────────────────────────

/** worldId → the realpath of that world's scratch dir (registered by its manager). */
const evalScratch = new Map<string, string>()
export function registerEvalScratch(worldId: string, dir: string): void { evalScratch.set(worldId, dir) }
export function unregisterEvalScratch(worldId: string): void { evalScratch.delete(worldId) }

function within(p: string, root: string): boolean {
  return path.isAbsolute(p) && path.resolve(p) === p && (p === root || p.startsWith(`${root}/`))
}

/** Fail closed: an eval world's command is exactly the confined, scratch-bound shape — or nothing. */
export function assertEvalSpawn(c: HostCommand, scope: Pick<EvalScope, 'worldId'>, home = os.homedir()): void {
  const refuse = (why: string): never => { throw new SandboxUnavailableError(`eval: host command refused in an eval world (${why})`) }
  const root = evalScratch.get(scope.worldId)
  if (!root) return refuse('this world has no scratch dir registered')
  if (!c.confine) return refuse('an eval command always runs confined')
  if (!within(c.cwd, root)) refuse(`cwd ${c.cwd} is outside the world's scratch dir`)
  if (!c.confine.writable.length) refuse('no writable dir')
  for (const w of c.confine.writable) if (!within(w, root)) refuse(`writable ${w} is outside the world's scratch dir`)
  if (!c.confine.denyReadUnder || !home || c.confine.denyReadUnder !== home) refuse('reads under the home dir must be denied')
  for (const r of c.confine.readable ?? []) if (!within(r, root)) refuse(`readable ${r} is outside the world's scratch dir`)
  for (const k of Object.keys(c.env)) if (!EVAL_ENV_KEYS.has(k)) refuse(`env ${k} is not allowed (no secrets in an eval world)`)
  if (!c.env.HOME || !within(c.env.HOME, root)) refuse('HOME must be inside the world\'s scratch dir')
  if (!c.env.TMPDIR || !within(c.env.TMPDIR, root)) refuse('TMPDIR must be inside the world\'s scratch dir')
}

// ── the runner ─────────────────────────────────────────────────────────────────────────────────

/** Run one command (see the header). Never rejects for the command's own failure — only a refused
 *  eval spawn throws. */
export function runHost(c: HostCommand): Promise<HostResult> {
  const scope = currentEvalScope()
  if (scope) assertEvalSpawn(c, scope)
  return new Promise<HostResult>((resolve) => {
    const out = new TailBuffer(c.capBytes)
    const err = new TailBuffer(c.capBytes)
    let timedOut = false
    let aborted = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let settled = false
    if (c.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }); return
    }
    const [file, args] = c.confine
      ? [SANDBOX_EXEC, ['-p', confinementProfile(c.confine), '/bin/bash', '-c', c.command]]
      : ['/bin/bash', ['-c', c.command]]
    const child = spawn(file, args, { cwd: c.cwd, env: c.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const pgid = child.pid ?? 0
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.stdin?.on('error', () => {})
    if (c.input !== undefined) child.stdin?.end(c.input)
    else child.stdin?.end()

    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup(pgid, 'SIGTERM')
      killTimer = setTimeout(() => { void killGroup(pgid) }, 2000)
    }, Math.max(1, c.timeoutMs))
    const onAbort = () => { aborted = true; void killGroup(pgid) }
    c.signal?.addEventListener('abort', onAbort, { once: true })

    let grace: ReturnType<typeof setTimeout> | null = null
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnErr?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (grace) clearTimeout(grace)
      c.signal?.removeEventListener('abort', onAbort)
      // A timed-out / aborted group, or a confined one, never outlives the call.
      if (timedOut || aborted || c.reapGroup) void killGroup(pgid)
      resolve({
        code: exited?.code ?? code,
        signal: exited?.signal ?? signal,
        stdout: out.toString(),
        stderr: spawnErr ? spawnErr.message : err.toString(),
        timedOut, aborted, truncated: out.truncated || err.truncated
      })
    }
    child.on('error', e => finish(null, null, e))
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      if (c.reapGroup || timedOut || aborted) void killGroup(pgid)
      // A clean command's `cmd &` child may still hold stdout open: don't wait on it forever.
      grace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code, signal)
      }, 500)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
