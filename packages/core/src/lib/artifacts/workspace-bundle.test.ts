// Cycle 86 Task 6: the REAL scripts run against a temp dir (cwd = the "workspace root").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const mocks = vi.hoisted(() => ({ broken: false, mode: 'local' as 'local' | 'remote' }))
vi.mock('../sandbox/secrets', async (orig) => {
  const real = await orig<typeof import('../sandbox/secrets')>()
  return { ...real, secretValues: vi.fn(async () => { if (mocks.broken) throw new real.SecretStoreUnavailableError(new Error('x')); return ['sk-SECRET-123'] }) }
})
vi.mock('../agent/runtime/execution-mode', () => ({ executionMode: () => mocks.mode }))

import { setWorkspaceRuntime } from '../sandbox/runtime'
import { ArtifactError } from './limits'
import { planReads, readWorkspaceBundle } from './workspace-bundle'

let tmp = ''
const write = (p: string, c: string | Buffer) => { const f = join(tmp, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c) }

function run(script: string, o: { input?: string; capBytes: number }): Promise<unknown> {
  return new Promise((resolve) => {
    const ch = spawn('sh', ['-c', script], { cwd: tmp })
    const out: Buffer[] = []; const err: Buffer[] = []
    ch.stdout.on('data', d => out.push(d)); ch.stderr.on('data', d => err.push(d))
    ch.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8')
      resolve({ stdout, stderr: Buffer.concat(err).toString(), exitCode: code, truncated: stdout.length > o.capBytes, timedOut: false, tainted: false })
    })
    ch.stdin.end(o.input ?? '')
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wsb-'))
  mocks.broken = false; mocks.mode = 'local'
  setWorkspaceRuntime({ manager: { exec: async (_id: string, script: string, o: { input?: string; capBytes: number }) => run(script, o) } } as never)
})
afterEach(() => { setWorkspaceRuntime(null); rmSync(tmp, { recursive: true, force: true }) })

describe('readWorkspaceBundle', () => {
  it('reads a built dist/ including nested and binary files', async () => {
    write('dist/index.html', '<script src="./assets/a.js"></script>')
    write('dist/assets/a.js', 'console.log(1)')
    write('dist/img/p.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    const r = await readWorkspaceBundle('ws', 'dist')
    expect(r.files.map(f => f.path).sort()).toEqual(['assets/a.js', 'img/p.png', 'index.html'])
    expect(r.files.find(f => f.path === 'img/p.png')!.content).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  })
  it('masks secrets in text files (Review Focus #1)', async () => {
    write('dist/index.html', 'ok'); write('dist/assets/a.js', 'const k="sk-SECRET-123"')
    const r = await readWorkspaceBundle('ws', 'dist')
    expect(r.files.find(f => f.path === 'assets/a.js')!.content.toString()).not.toContain('sk-SECRET-123')
    expect(r.masked).toBe(1)
  })
  it('refuses when the secret store is unreadable', async () => {
    write('dist/index.html', 'ok'); mocks.broken = true
    const e = await readWorkspaceBundle('ws', 'dist').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError)
    expect(e.code).toBe('refused')
    expect(e.message).toMatch(/secret store/)
  })
  it('skips dot-dirs, node_modules and symlinks', async () => {
    write('dist/index.html', 'ok'); write('dist/.git/config', 'x'); write('dist/node_modules/m/i.js', 'x')
    symlinkSync('/etc/passwd', join(tmp, 'dist/evil'))
    const r = await readWorkspaceBundle('ws', 'dist')
    expect(r.files.map(f => f.path)).toEqual(['index.html'])
  })
  it('rejects a dir outside the workspace', async () => {
    for (const d of ['../', '/etc', '..']) {
      const e = await readWorkspaceBundle('ws', d).catch(x => x)
      expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('bad_path')
    }
  })
  it('rejects a dir symlinked outside the workspace', async () => {
    symlinkSync('/etc', join(tmp, 'sneaky'))
    const e = await readWorkspaceBundle('ws', 'sneaky').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('bad_path')
  })
  it('missing dir → not_found', async () => {
    const e = await readWorkspaceBundle('ws', 'nope').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('not_found')
  })
  it('stops at 501 files', async () => {
    for (let i = 0; i < 501; i++) write(`dist/f${i}.txt`, 'x')
    const e = await readWorkspaceBundle('ws', 'dist').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('too_many')
    expect(e.message).toMatch(/more than 500 files/)
  })
  it('rejects a single 10 MB+ file, naming it', async () => {
    write('dist/big.bin', ''); truncateSync(join(tmp, 'dist/big.bin'), 10 * 1024 * 1024 + 1)
    const e = await readWorkspaceBundle('ws', 'dist').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('too_large')
    expect(e.message).toContain('big.bin')
  })
  it('rejects a total over 25 MB', async () => {
    for (let i = 0; i < 3; i++) { write(`dist/b${i}.bin`, ''); truncateSync(join(tmp, `dist/b${i}.bin`), 9 * 1024 * 1024) }
    const e = await readWorkspaceBundle('ws', 'dist').catch(x => x)
    expect(e).toBeInstanceOf(ArtifactError); expect(e.code).toBe('too_large')
  })
  it('reassembles a file larger than one chunk', async () => {
    const big = randomBytes(2 * 1024 * 1024)
    write('dist/big.bin', big); write('dist/index.html', 'ok')
    const r = await readWorkspaceBundle('ws', 'dist')
    expect(r.files.find(f => f.path === 'big.bin')!.content.equals(big)).toBe(true)
  })
  it('refuses in remote execution mode', async () => {
    mocks.mode = 'remote'
    await expect(readWorkspaceBundle('ws', 'dist')).rejects.toThrow(/only works inside Bridget's runs/)
  })
})

describe('planReads', () => {
  it('packs small files and splits big ones', () => {
    const b = planReads([{ path: 'a', size: 10 }, { path: 'b', size: 25 }, { path: 'c', size: 5 }], 20)
    expect(b).toEqual([
      [{ path: 'a', offset: 0, length: 10 }, { path: 'b', offset: 0, length: 10 }],
      [{ path: 'b', offset: 10, length: 15 }, { path: 'c', offset: 0, length: 5 }]
    ])
  })
  it('zero-byte files still get a piece', () => expect(planReads([{ path: 'e', size: 0 }], 20)).toEqual([[{ path: 'e', offset: 0, length: 0 }]]))
})
