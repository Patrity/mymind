// Constrained command runner. Honest isolation: least-privilege uid + cwd-jail +
// stripped env + timeout + output cap + the container boundary. NOT a syscall
// sandbox. Fails CLOSED when it cannot drop privileges (never runs as the app user).
import { spawn } from 'node:child_process'
import path from 'node:path'

export class ExecDisabledError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecDisabledError' }
}

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export function buildExecEnv(opts: { path?: string; home: string }): Record<string, string> {
  // Construct from scratch (allowlist), so no app secret can leak by omission.
  return { PATH: opts.path || DEFAULT_PATH, HOME: opts.home, LANG: 'C.UTF-8' }
}

export function resolveExecCwd(workspaceRoot: string, cwd?: string): string {
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, cwd ?? '.')
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`cwd escapes the workspace jail: ${cwd}`)
  }
  return resolved
}

export type ExecMode =
  | { mode: 'setuid'; uid: number; gid: number }
  | { mode: 'unconfined' }
  | { mode: 'disabled'; reason: string }

export function selectExecMode(env: {
  uid: number | undefined
  agentUid: number | null
  agentGid: number | null
  nodeEnv: string | undefined
  unconfined: boolean
}): ExecMode {
  const isRoot = env.uid === 0
  if (isRoot && env.agentUid != null && env.agentUid !== 0) {
    return { mode: 'setuid', uid: env.agentUid, gid: env.agentGid ?? env.agentUid }
  }
  // Dev-only escape hatch: never in production, always loud, still jailed.
  if (env.nodeEnv !== 'production' && env.unconfined) return { mode: 'unconfined' }
  return {
    mode: 'disabled',
    reason: isRoot
      ? 'no agent user configured (set EXEC_AGENT_UID)'
      : 'process is not root; cannot setuid to a low-privilege user'
  }
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  mode: 'setuid' | 'unconfined'
}

export async function runConstrained(
  command: string,
  opts: { cwd?: string; signal?: AbortSignal; workspaceRoot?: string; timeoutMs?: number; outputCapBytes?: number } = {}
): Promise<ExecResult> {
  const workspaceRoot = opts.workspaceRoot ?? process.env.EXEC_WORKSPACE_DIR ?? '/workspace'
  const cwd = resolveExecCwd(workspaceRoot, opts.cwd)
  const timeoutMs = opts.timeoutMs ?? Number(process.env.EXEC_TIMEOUT_MS ?? 60_000)
  const cap = opts.outputCapBytes ?? 64 * 1024

  const agentUid = process.env.EXEC_AGENT_UID ? Number(process.env.EXEC_AGENT_UID) : null
  const agentGid = process.env.EXEC_AGENT_GID ? Number(process.env.EXEC_AGENT_GID) : null
  const decided = selectExecMode({
    uid: process.getuid?.(),
    agentUid,
    agentGid,
    nodeEnv: process.env.NODE_ENV,
    unconfined: process.env.EXEC_UNCONFINED === '1'
  })
  if (decided.mode === 'disabled') throw new ExecDisabledError(`exec is disabled: ${decided.reason}`)
  if (decided.mode === 'unconfined') {
    console.warn('[exec] UNCONFINED dev mode — running WITHOUT privilege drop (jail + stripped env still apply). Never set EXEC_UNCONFINED in production.')
  }

  const env = buildExecEnv({ path: process.env.PATH, home: workspaceRoot })
  const spawnOpts: Parameters<typeof spawn>[2] = { cwd, env, detached: true }
  if (decided.mode === 'setuid') { spawnOpts.uid = decided.uid; spawnOpts.gid = decided.gid }

  return await new Promise<ExecResult>((resolve, reject) => {
    let child
    try {
      child = spawn('/bin/sh', ['-c', command], spawnOpts)
    } catch (err) {
      reject(new ExecDisabledError(`exec spawn failed: ${(err as Error).message}`)); return
    }
    let out = ''
    let errs = ''
    let timedOut = false
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
    const onAbort = () => { kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort)
      reject(new ExecDisabledError(`exec process error: ${(err as Error).message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode: code, stdout: out, stderr: errs, timedOut, mode: decided.mode === 'setuid' ? 'setuid' : 'unconfined' })
    })
  })
}
