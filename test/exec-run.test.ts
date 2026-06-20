import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
  it('injects secrets into the env when provided', () => {
    const env = buildExecEnv({ path: '/usr/bin', home: '/workspace', secrets: { GH_TOKEN: 'tok_abc' } })
    expect(env.GH_TOKEN).toBe('tok_abc')
  })
})

describe('resolveExecCwd', () => {
  it('defaults to the workspace root when cwd is omitted', () => {
    expect(resolveExecCwd('/workspace')).toBe('/workspace')
  })
  it('resolves sub-paths relative to the workspace root', () => {
    expect(resolveExecCwd('/workspace', 'sub')).toBe('/workspace/sub')
    expect(resolveExecCwd('/workspace', 'a/../b')).toBe('/workspace/b')
  })
  it('allows an absolute cwd anywhere (no jail — root in LXC boundary is enough)', () => {
    expect(resolveExecCwd('/workspace', '/etc')).toBe('/etc')
    expect(resolveExecCwd('/workspace', '/etc/passwd')).toBe('/etc/passwd')
  })
  it('resolves traversal paths without throwing', () => {
    expect(resolveExecCwd('/workspace', '../etc')).toBe('/etc')
  })
})

describe('resolveExecCwd — symlink behavior (no jail defense needed)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mymind-ws-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('accepts a normal (non-symlink) existing subdirectory', () => {
    mkdirSync(join(workspace, 'sub'))
    // No jail → path.resolve (lexical), not realpathSync
    expect(resolveExecCwd(workspace, 'sub')).toBe(join(workspace, 'sub'))
  })

  it('returns the lexical path for a non-existent subdirectory (no throw)', () => {
    const result = resolveExecCwd(workspace, 'nonexistent')
    expect(result).toBe(join(workspace, 'nonexistent'))
  })
})

describe('selectExecMode', () => {
  it('root → native-root (prod: root-in-LXC is the boundary)', () => {
    expect(selectExecMode({ uid: 0, nodeEnv: 'production', unconfined: false })).toEqual({ mode: 'native-root' })
  })
  it('root → native-root regardless of unconfined flag', () => {
    expect(selectExecMode({ uid: 0, nodeEnv: 'production', unconfined: true })).toEqual({ mode: 'native-root' })
  })
  it('non-root dev with EXEC_UNCONFINED → unconfined', () => {
    expect(selectExecMode({ uid: 1000, nodeEnv: 'development', unconfined: true })).toEqual({ mode: 'unconfined' })
  })
  it('non-root without the dev hatch → disabled', () => {
    const m = selectExecMode({ uid: 1000, nodeEnv: 'production', unconfined: false })
    expect(m.mode).toBe('disabled')
  })
  it('disables when not root in production even if unconfined is set', () => {
    expect(selectExecMode({ uid: 1000, nodeEnv: 'production', unconfined: true }).mode).toBe('disabled')
  })
  it('allows unconfined ONLY in non-production when explicitly opted in', () => {
    expect(selectExecMode({ uid: 1000, nodeEnv: 'development', unconfined: true }).mode).toBe('unconfined')
    expect(selectExecMode({ uid: 1000, nodeEnv: 'development', unconfined: false }).mode).toBe('disabled')
  })
  it('disables when uid is undefined (not root)', () => {
    expect(selectExecMode({ uid: undefined, nodeEnv: 'production', unconfined: false }).mode).toBe('disabled')
  })
})

describe('buildSpawnArgs', () => {
  it('native-root mode → /bin/sh -c (no setpriv)', () => {
    expect(buildSpawnArgs({ mode: 'native-root' }, 'echo hi')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'echo hi']
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
