// Constrained command runner. Root-in-LXC IS the boundary (no setpriv/uid drop needed).
// Isolation layers: stripped env + timeout + output cap + the LXC container boundary.
// Fails CLOSED when exec is not configured for native-root operation.
import { spawn } from 'node:child_process'
import path from 'node:path'

export class ExecDisabledError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecDisabledError' }
}

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export function buildExecEnv(opts: { path?: string; home: string; secrets?: Record<string, string> }): Record<string, string> {
  // Construct from scratch (allowlist), so no app secret can leak by omission.
  const base: Record<string, string> = { PATH: opts.path || DEFAULT_PATH, HOME: opts.home, LANG: 'C.UTF-8' }
  if (opts.secrets) {
    for (const [k, v] of Object.entries(opts.secrets)) {
      base[k] = v
    }
  }
  return base
}

export function resolveExecCwd(defaultDir: string, cwd?: string): string {
  // Absolute paths go straight through (no jail). Relative paths anchor against defaultDir.
  if (!cwd) return path.resolve(defaultDir)
  if (path.isAbsolute(cwd)) return cwd
  return path.resolve(defaultDir, cwd)
}

export type ExecMode =
  | { mode: 'native-root' }
  | { mode: 'unconfined' }            // non-root dev machines (EXEC_UNCONFINED=1, non-prod)
  | { mode: 'disabled'; reason: string }

export function selectExecMode(env: { uid: number | undefined; nodeEnv: string | undefined; unconfined: boolean }): ExecMode {
  if (env.uid === 0) return { mode: 'native-root' }                       // prod: root in the LXC IS the boundary
  if (env.nodeEnv !== 'production' && env.unconfined) return { mode: 'unconfined' }
  return { mode: 'disabled', reason: 'native exec requires running as root in the LXC' }
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  mode: 'native-root' | 'unconfined'
}

/** Build the spawn argv for the chosen mode. Root-in-LXC: no setpriv needed. */
export function buildSpawnArgs(_mode: ExecMode, command: string): { file: string; args: string[] } {
  return { file: '/bin/sh', args: ['-c', command] } // no setpriv — root-in-LXC
}

export async function runConstrained(
  command: string,
  opts: { cwd?: string; signal?: AbortSignal; workspaceRoot?: string; timeoutMs?: number; outputCapBytes?: number; secrets?: Record<string, string> } = {}
): Promise<ExecResult> {
  const workspaceRoot = opts.workspaceRoot ?? process.env.EXEC_WORKSPACE_DIR ?? '/opt/mymind/workspace'
  const cwd = resolveExecCwd(workspaceRoot, opts.cwd)
  const timeoutMs = opts.timeoutMs ?? Number(process.env.EXEC_TIMEOUT_MS ?? 60_000)
  const cap = opts.outputCapBytes ?? 64 * 1024

  const decided = selectExecMode({ uid: process.getuid?.(), nodeEnv: process.env.NODE_ENV, unconfined: process.env.EXEC_UNCONFINED === '1' })
  if (decided.mode === 'disabled') throw new ExecDisabledError(`exec is disabled: ${decided.reason}`)
  if (decided.mode === 'unconfined') {
    console.warn('[exec] UNCONFINED dev mode — running WITHOUT privilege drop (stripped env still applies). Never set EXEC_UNCONFINED in production.')
  }

  const env = buildExecEnv({ path: process.env.PATH, home: workspaceRoot, secrets: opts.secrets })
  const spawnOpts: Parameters<typeof spawn>[2] = { cwd, env, detached: true }

  const { file, args } = buildSpawnArgs(decided, command)
  const resolvedMode = decided.mode === 'native-root' ? 'native-root' : 'unconfined'

  // Pre-spawn guard: if the signal is already aborted, resolve immediately without spawning.
  if (opts.signal?.aborted) {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, mode: resolvedMode }
  }

  return await new Promise<ExecResult>((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, spawnOpts)
    } catch (err) {
      reject(new ExecDisabledError(`exec spawn failed: ${(err as Error).message}`)); return
    }
    let out = ''
    let errs = ''
    let timedOut = false
    let aborted = false
    let outLen = 0
    let errLen = 0
    const append = (buf: Buffer, kind: 'out' | 'err') => {
      if (kind === 'out') {
        if (outLen >= cap) return
        const room = cap - outLen
        out += buf.subarray(0, room).toString('utf8'); outLen += Math.min(buf.length, room)
        if (outLen >= cap) out += '\n…[output truncated]'
      } else {
        if (errLen >= cap) return
        const room = cap - errLen
        errs += buf.subarray(0, room).toString('utf8'); errLen += Math.min(buf.length, room)
        if (errLen >= cap) errs += '\n…[output truncated]'
      }
    }
    child.stdout?.on('data', (d: Buffer) => append(d, 'out'))
    child.stderr?.on('data', (d: Buffer) => append(d, 'err'))

    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    const onAbort = () => { aborted = true; kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort)
      reject(new ExecDisabledError(`exec process error: ${(err as Error).message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code, stdout: out, stderr: errs, timedOut, aborted, mode: resolvedMode })
    })
  })
}
