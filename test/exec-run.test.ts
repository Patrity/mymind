import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExecEnv, resolveExecCwd, selectExecMode, buildSpawnArgs, runConstrained } from '../server/lib/exec/run'

describe('buildExecEnv', () => {
  it('returns exactly PATH/HOME/LANG and nothing else (allowlist by construction)', () => {
    const env = buildExecEnv({ path: '/usr/bin:/bin', home: '/workspace' })
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/workspace', LANG: 'C.UTF-8' })
  })
  it('falls back to a safe PATH when none is given', () => {
    const env = buildExecEnv({ home: '/workspace' })
    expect(env.PATH).toContain('/usr/bin')
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH'])
  })
})

describe('resolveExecCwd', () => {
  it('defaults to the workspace root', () => {
    expect(resolveExecCwd('/workspace')).toBe('/workspace')
    expect(resolveExecCwd('/workspace', '.')).toBe('/workspace')
  })
  it('resolves sub-paths inside the jail', () => {
    expect(resolveExecCwd('/workspace', 'sub')).toBe('/workspace/sub')
    expect(resolveExecCwd('/workspace', 'a/../b')).toBe('/workspace/b')
  })
  it('rejects traversal and absolute escapes', () => {
    expect(() => resolveExecCwd('/workspace', '../etc')).toThrow()
    expect(() => resolveExecCwd('/workspace', '/etc/passwd')).toThrow()
    expect(() => resolveExecCwd('/workspace', '../workspace-evil')).toThrow()
  })
})

describe('resolveExecCwd — symlink jail escape (realpath defense-in-depth)', () => {
  let workspace: string
  let outside: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mymind-ws-'))
    outside = mkdtempSync(join(tmpdir(), 'mymind-outside-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects a symlink inside workspace that points outside the jail', () => {
    // Create workspace/evil -> outside (an out-of-jail dir)
    symlinkSync(outside, join(workspace, 'evil'))
    expect(() => resolveExecCwd(workspace, 'evil')).toThrow(/cwd escapes the workspace jail/)
  })

  it('accepts a normal (non-symlink) existing subdirectory', () => {
    mkdirSync(join(workspace, 'sub'))
    const result = resolveExecCwd(workspace, 'sub')
    // On macOS /tmp is a symlink → use realpathSync to get the canonical form the function returns
    expect(result).toBe(realpathSync(join(workspace, 'sub')))
  })

  it('returns the lexical path for a non-existent subdirectory (no throw)', () => {
    // Path doesn't exist — can't be a symlink; shell will fail naturally
    const result = resolveExecCwd(workspace, 'nonexistent')
    expect(result).toBe(join(workspace, 'nonexistent'))
  })
})

describe('selectExecMode', () => {
  const base = { uid: 0, agentUid: 10001, agentGid: 10001, nodeEnv: 'production', unconfined: false }
  it('setuids when root with an agent user', () => {
    expect(selectExecMode(base)).toEqual({ mode: 'setuid', uid: 10001, gid: 10001 })
  })
  it('disables (fail-closed) when root but no agent user', () => {
    expect(selectExecMode({ ...base, agentUid: null }).mode).toBe('disabled')
  })
  it('disables when not root in production even if unconfined is set', () => {
    expect(selectExecMode({ uid: 1000, agentUid: null, agentGid: null, nodeEnv: 'production', unconfined: true }).mode).toBe('disabled')
  })
  it('allows unconfined ONLY in non-production when explicitly opted in', () => {
    expect(selectExecMode({ uid: 1000, agentUid: null, agentGid: null, nodeEnv: 'development', unconfined: true }).mode).toBe('unconfined')
    expect(selectExecMode({ uid: 1000, agentUid: null, agentGid: null, nodeEnv: 'development', unconfined: false }).mode).toBe('disabled')
  })
  it('disables when root with agentUid === 0 (rejects root-as-agent)', () => {
    expect(selectExecMode({ ...base, agentUid: 0 }).mode).toBe('disabled')
  })
})

describe('buildSpawnArgs', () => {
  it('setuid mode → setpriv argv with full privilege drop args', () => {
    expect(buildSpawnArgs({ mode: 'setuid', uid: 10001, gid: 10001 }, 'echo hi')).toEqual({
      file: 'setpriv',
      args: ['--reuid', '10001', '--regid', '10001', '--clear-groups', '--', '/bin/sh', '-c', 'echo hi']
    })
  })
  it('unconfined mode → /bin/sh -c', () => {
    expect(buildSpawnArgs({ mode: 'unconfined' }, 'echo hi')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'echo hi']
    })
  })
})

describe('runConstrained (real spawn, unconfined dev mode)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mymind-ws-'))
  const opts = { workspaceRoot: ws, signal: undefined }

  let savedExecUnconfined: string | undefined
  let savedDatabaseUrl: string | undefined
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    savedExecUnconfined = process.env.EXEC_UNCONFINED
    savedDatabaseUrl = process.env.DATABASE_URL
    savedNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    if (savedExecUnconfined === undefined) delete process.env.EXEC_UNCONFINED
    else process.env.EXEC_UNCONFINED = savedExecUnconfined

    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedDatabaseUrl

    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  })

  it('runs a command and captures stdout', async () => {
    process.env.EXEC_UNCONFINED = '1'
    process.env.NODE_ENV = 'development'
    const r = await runConstrained('echo hello', opts)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.mode).toBe('unconfined')
  })
  it('does NOT leak app secrets into the child env', async () => {
    process.env.EXEC_UNCONFINED = '1'
    process.env.NODE_ENV = 'development'
    process.env.DATABASE_URL = 'postgres://should-not-leak'
    const r = await runConstrained('echo "[$DATABASE_URL]"', opts)
    expect(r.stdout.trim()).toBe('[]')
  })
  it('times out a long command and reports timedOut', async () => {
    process.env.EXEC_UNCONFINED = '1'
    process.env.NODE_ENV = 'development'
    const r = await runConstrained('sleep 5', { ...opts, timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.aborted).toBe(false)
  })
  it('resolves with aborted:true when signal fires mid-run', async () => {
    process.env.EXEC_UNCONFINED = '1'
    process.env.NODE_ENV = 'development'
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await runConstrained('sleep 5', { ...opts, signal: ac.signal })
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
  })
  it('returns aborted:true immediately when signal is already aborted before spawn', async () => {
    process.env.EXEC_UNCONFINED = '1'
    process.env.NODE_ENV = 'development'
    const ac = new AbortController()
    ac.abort()
    const r = await runConstrained('sleep 5', { ...opts, signal: ac.signal })
    expect(r.aborted).toBe(true)
    expect(r.exitCode).toBeNull()
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })
})
