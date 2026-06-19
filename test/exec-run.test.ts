import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExecEnv, resolveExecCwd, selectExecMode, runConstrained } from '../server/lib/exec/run'

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
  })
})
