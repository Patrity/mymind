// Cycle 86 Task 1 — the host workspace manager against real processes and an in-memory store:
// relative / absolute paths, secrets, taint as bookkeeping only (option C: a tainted run's command
// runs like a clean one, the workspace is marked), the eval world (always confined, realpath'd
// profile paths), the low-disk alarm, the idle stop, background shells as process groups (kill,
// restart re-attach / lost), and MyMind's own readers (no symlink, no FIFO wedge).
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSandboxManager, type SandboxManagerOptions } from './manager'
import { SandboxDiskLowError, SandboxUnavailableError } from './errors'
import type { WorkspaceRow, WorkspaceStore } from './store'
import { createShellRegistry, type ShellStore, type WorkspaceShellRow } from './shells'

const darwin = process.platform === 'darwin'
const WS = '11111111-1111-4111-8111-111111111111'
const W2 = '22222222-2222-4222-8222-222222222222'
let dir: string
let outside: string

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-mgr-')))
  outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-mgr-out-')))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

function row(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  const now = new Date()
  return { id, kind: 'workstream', workstreamId: null, containerId: null, state: 'stopped', bytesUsed: 0, inodesUsed: 0, tainted: false, taintedAt: null, lastUsedAt: now, createdAt: now, deletedAt: null, ns: 'default', ...over } as WorkspaceRow
}

function memStore(rows: WorkspaceRow[]): WorkspaceStore & { rows: Map<string, WorkspaceRow> } {
  const m = new Map(rows.map(r => [r.id, r]))
  return {
    rows: m,
    async get(id) { return m.get(id) ?? null },
    async setContainer(id, containerId, state) { const r = m.get(id); if (r) m.set(id, { ...r, containerId, state }) },
    async touch(id) { const r = m.get(id); if (r) m.set(id, { ...r, lastUsedAt: new Date() }) },
    async setUsage() {},
    async setTainted(id, tainted) { const r = m.get(id); if (r) m.set(id, { ...r, tainted, taintedAt: tainted ? new Date() : null }) },
    async listRunning() { return [...m.values()].filter(r => r.state === 'running' && !r.deletedAt) },
    async stampOrphans() { return 0 },
    async listExpired() { return [] },
    async remove(id) { m.delete(id) }
  }
}

function mgr(o: Partial<SandboxManagerOptions> = {}) {
  const store = memStore([row(WS), row(W2)])
  const m = createSandboxManager({
    store,
    settings: { workspacesDir: path.join(dir, `m-${Math.random().toString(36).slice(2, 8)}`) },
    env: { HOME: os.homedir(), USER: 'bridget', PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', DATABASE_URL: 'postgres://worker-only' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...o
  })
  return { m, store }
}

describe('paths: relative → the workspace dir, absolute → anywhere (clean runs)', () => {
  it('cwd is the workspace dir; a relative write lands there; an absolute one lands where it points', async () => {
    const { m } = mgr()
    const target = path.join(outside, 'abs.txt')
    const r = await m.exec(WS, `pwd; echo rel > rel.txt; echo abs > ${JSON.stringify(target)}`)
    const wsDir = await realpath(m.hostDir(WS))
    expect(r).toMatchObject({ exitCode: 0, stdout: `${wsDir}\n`, tainted: false })
    expect(r.confined).toBeUndefined()
    expect(await readFile(path.join(wsDir, 'rel.txt'), 'utf8')).toBe('rel\n')
    expect(await readFile(target, 'utf8')).toBe('abs\n')
  })

  it('a command never sees the worker\'s env; exported secrets reach agent commands (tainted ones too), never MyMind\'s own scripts', async () => {
    const { m } = mgr()
    const clean = await m.exec(WS, 'echo "db=[$DATABASE_URL] tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' } })
    expect(clean.stdout).toBe('db=[] tok=[tok-123]\n')
    const tainted = await m.exec(W2, 'echo "tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' }, tainted: true })
    expect(tainted.stdout).toBe('tok=[tok-123]\n') // option C: a tainted run runs like a clean one
    const internal = await m.exec(WS, 'echo "tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' }, internal: true })
    expect(internal.stdout).toBe('tok=[]\n')
    await expect(m.exec(WS, 'true', { secrets: { PATH: '/evil' } })).rejects.toThrow(/invalid sandbox secret name/)
  })
})

describe('taint is bookkeeping only (cycle 86 option C)', () => {
  it('a tainted run\'s command runs like a clean one — reaches a loopback listener, writes anywhere, gets secrets — and marks the workspace', async () => {
    const { m, store } = mgr()
    let accepted = 0
    const server = net.createServer((c) => { accepted++; c.on('error', () => {}); c.end('x') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    try {
      const target = path.join(outside, `tainted-${process.pid}.txt`)
      const r = await m.exec(WS, `python3 -I -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 3)' ${port} && echo "ok tok=[$GH_TOKEN]" && echo out > ${JSON.stringify(target)}`, { tainted: true, secrets: { GH_TOKEN: 'tok-9' } })
      expect(r).toMatchObject({ exitCode: 0, stdout: 'ok tok=[tok-9]\n', tainted: true })
      expect(r.confined).toBeUndefined()
      expect(accepted).toBe(1)
      expect(await readFile(target, 'utf8')).toBe('out\n')
      expect(store.rows.get(WS)!.tainted).toBe(true)
      // Persistent: a later clean command's result still says the workspace is tainted (its readers are).
      expect(await m.exec(WS, 'true')).toMatchObject({ tainted: true })
      expect(await m.exec(W2, 'true')).toMatchObject({ tainted: false })
    } finally { await new Promise(r => server.close(r)) }
  })

  it('markTainted (a guard flag on workspace content) only marks the row — nothing is stopped', async () => {
    const onStopped = vi.fn()
    const { m, store } = mgr({ onStopped })
    await m.markTainted(W2)
    await m.markTainted(W2) // idempotent
    expect(store.rows.get(W2)!.tainted).toBe(true)
    expect(onStopped).not.toHaveBeenCalled()
  })

  it('eval worlds need macOS sandbox-exec: refused elsewhere (fail closed); agent commands are unaffected', async () => {
    const { createEvalSandboxManager } = await import('./manager')
    const store = memStore([row(WS)])
    const m = createEvalSandboxManager({ runId: 'r', worldId: 'eval_00000000000040008000000000000ab1_00000002' }, { store, platform: 'linux', settings: { evalScratchDir: path.join(dir, 'scratch2') }, log: { info: () => {}, warn: () => {}, error: () => {} } })
    await expect(m.exec(WS, 'true')).rejects.toThrow(/needs macOS sandbox-exec/)
    const { m: agent } = mgr({ platform: 'linux' })
    expect((await agent.exec(WS, 'echo ok', { tainted: true })).stdout).toBe('ok\n')
  })
})

describe('final review C1: production refuses the host runtime off macOS', () => {
  const base = { HOME: os.homedir(), USER: 'bridget', PATH: '/usr/bin:/bin' }

  it('in production on linux every non-eval command (internal included) is refused with a clear error, before any dir is made', async () => {
    const { m } = mgr({ platform: 'linux', env: { ...base, NODE_ENV: 'production' } })
    await expect(m.exec(WS, 'echo pwned')).rejects.toThrow(SandboxUnavailableError)
    await expect(m.exec(WS, 'echo pwned')).rejects.toThrow(/workspace unavailable on this host/)
    await expect(m.exec(WS, 'true', { internal: true })).rejects.toThrow(/workspace unavailable on this host/)
    await expect(readFile(m.hostDir(WS))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await m.health()).toMatchObject({ ok: false, reason: expect.stringMatching(/workspace unavailable on this host/) })
  })

  it('MYMIND_HOST_RUNTIME_ALLOWED=1 lifts it; darwin and non-production are never refused', async () => {
    for (const o of [
      { platform: 'linux' as const, env: { ...base, NODE_ENV: 'production', MYMIND_HOST_RUNTIME_ALLOWED: '1' } },
      { platform: 'darwin' as const, env: { ...base, NODE_ENV: 'production' } },
      { platform: 'linux' as const, env: { ...base, NODE_ENV: 'development' } }
    ]) {
      const { m } = mgr(o)
      expect((await m.exec(WS, 'echo ok')).stdout).toBe('ok\n')
    }
    const { m } = mgr({ platform: 'linux', env: { ...base, NODE_ENV: 'production', MYMIND_HOST_RUNTIME_ALLOWED: 'true' } })
    await expect(m.exec(WS, 'true')).rejects.toThrow(/workspace unavailable on this host/)
  })
})

describe('eval worlds: always confined', () => {
  it.runIf(darwin)('a clean run: confined to the world dir, offline, no secrets allowed', async () => {
    const { createEvalSandboxManager } = await import('./manager')
    const store = memStore([row(WS)])
    const scratch = path.join(dir, 'scratch')
    const m = createEvalSandboxManager({ runId: 'r', worldId: 'eval_00000000000040008000000000000ab1_00000001' }, {
      store, settings: { evalScratchDir: scratch }, log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    expect(m.offline).toBe(true)
    const r = await m.exec(WS, `echo in > in.txt; echo "home=$HOME"; echo out > ${JSON.stringify(path.join(outside, 'eval.txt'))}`)
    expect(r.confined).toBe(true)
    expect(r.stdout).toContain(`home=${await realpath(path.join(scratch, 'eval_00000000000040008000000000000ab1_00000001'))}/.home`)
    expect(r.stderr).toMatch(/Operation not permitted/)
    await expect(readFile(path.join(outside, 'eval.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    // Even MyMind's own scripts run confined in a world.
    expect((await m.exec(WS, 'true', { internal: true })).confined).toBe(true)
    await expect(m.exec(WS, 'true', { secrets: { GH_TOKEN: 'x' } })).rejects.toThrow(/never available in an eval world/)
  })

  it.runIf(darwin)('fix round 2: every profile path is a realpath — a symlinked scratch dir and a symlinked home still confine', async () => {
    const { createEvalSandboxManager } = await import('./manager')
    const realScratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-rs-')))
    const realHome = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-rh-')))
    const linkScratch = path.join(dir, `scratch-link-${process.pid}`)
    const linkHome = path.join(dir, `home-link-${process.pid}`)
    await symlink(realScratch, linkScratch)
    await symlink(realHome, linkHome)
    await writeFile(path.join(realHome, 'secret.txt'), 'HOME-SECRET')
    try {
      const store = memStore([row(WS)])
      const m = createEvalSandboxManager({ runId: 'r', worldId: 'eval_00000000000040008000000000000ab1_00000004' }, {
        store, home: linkHome, settings: { evalScratchDir: linkScratch }, log: { info: () => {}, warn: () => {}, error: () => {} }
      })
      // Allowed writes are named by realpath (through the symlink they would match nothing → EPERM)…
      const w = await m.exec(WS, 'echo in > in.txt && cat in.txt')
      expect(w).toMatchObject({ exitCode: 0, stdout: 'in\n' })
      // …and so is the denied home: reading it through either path fails.
      const r = await m.exec(WS, `cat ${linkHome}/secret.txt; echo "|$?"; cat ${realHome}/secret.txt; echo "|$?"`)
      expect(r.stdout).toBe('|1\n|1\n')
      // A profile naming the SYMLINKED home would have let both reads through (why realpaths matter).
      const { runHost } = await import('./host/spawn')
      const naive = await runHost({ command: `cat ${realHome}/secret.txt`, cwd: realScratch, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000, capBytes: 4096, confine: { writable: [realScratch], denyReadUnder: linkHome } })
      expect(naive.stdout).toBe('HOME-SECRET')
    } finally {
      await rm(realScratch, { recursive: true, force: true }); await rm(realHome, { recursive: true, force: true })
    }
  })
})

describe('the low-disk alarm (< 5 GB pauses new work, ≥ 8 GB resumes)', () => {
  it('enters once, refuses new work (not MyMind\'s own reads), holds between the thresholds, recovers at 8 GB', async () => {
    let free = 6 * 1024 ** 3
    const { m } = mgr({ fsStats: async () => ({ freeBytes: free }) })
    expect(await m.diskCheck()).toMatchObject({ low: false, entered: false })
    free = 4.9 * 1024 ** 3
    expect(await m.diskCheck()).toMatchObject({ low: true, entered: true })
    expect(await m.diskCheck()).toMatchObject({ low: true, entered: false }) // once per episode
    await expect(m.exec(WS, 'true')).rejects.toBeInstanceOf(SandboxDiskLowError)
    expect((await m.exec(WS, 'echo ui', { internal: true })).stdout).toBe('ui\n')
    expect(await m.health()).toMatchObject({ ok: false, reason: expect.stringMatching(/low on disk/) })
    free = 7.9 * 1024 ** 3
    expect(await m.diskCheck()).toMatchObject({ low: true, recovered: false })
    free = 8 * 1024 ** 3
    expect(await m.diskCheck()).toMatchObject({ low: false, recovered: true })
    expect((await m.exec(WS, 'echo back')).stdout).toBe('back\n')
  })
})

describe('idle stop and teardown', () => {
  it('a workspace idle for 15 min loses its shells (onStopped); an armed watch keeps it', async () => {
    let t = Date.now()
    const onStopped = vi.fn()
    let busy = true
    const { m, store } = mgr({ now: () => t, onStopped, isBusy: () => busy })
    await m.exec(WS, 'true')
    expect(store.rows.get(WS)!.state).toBe('running')
    store.rows.set(WS, { ...store.rows.get(WS)!, lastUsedAt: new Date(t) })
    t += 16 * 60_000
    expect(await m.idleStop()).toEqual([])
    busy = false
    expect(await m.idleStop()).toEqual([WS])
    expect(onStopped).toHaveBeenCalledWith(WS, expect.stringMatching(/idle for 15 min/))
    expect(store.rows.get(WS)!.state).toBe('stopped')
  })
})

describe('background shells as process groups (real processes)', () => {
  function memShells(): ShellStore {
    const m = new Map<string, WorkspaceShellRow>()
    let n = 0
    return {
      async create(workspaceId, command) {
        const r = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, workspaceId, command, state: 'running', exitCode: null, reason: null, readOffset: 0, startedAt: new Date(), endedAt: null } as WorkspaceShellRow
        m.set(r.id, r); return r
      },
      async get(id) { return m.get(id) ?? null },
      async listRunning(ws) { return [...m.values()].filter(r => r.state === 'running' && (!ws || r.workspaceId === ws)) },
      async list(ws) { return [...m.values()].filter(r => r.workspaceId === ws) },
      async end(id, patch) { const r = m.get(id); if (!r || r.state !== 'running') return false; m.set(id, { ...r, state: patch.state, exitCode: patch.exitCode ?? null, reason: patch.reason ?? null, endedAt: new Date() }); return true },
      async setOffset(id, offset) { const r = m.get(id); if (r) m.set(id, { ...r, readOffset: offset }) }
    }
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  it('start → output → kill leaves no process in its group; a worker restart re-attaches a live shell and marks a dead one lost', async () => {
    const { m, store } = mgr()
    const shells = memShells()
    const deps = { exec: m.exec, peek: m.peek, workspace: (id: string) => store.get(id), store: shells, secretValues: async () => [] }
    const reg = createShellRegistry(deps)
    const a = await reg.start(WS, 'sleep 60 & echo "child=$!"; echo started; wait')
    const b = await reg.start(WS, 'echo hi; sleep 60')
    await new Promise(r => setTimeout(r, 400))
    const out = await reg.output(WS, a.shellId)
    expect(out).toMatchObject({ state: 'running', output: expect.stringContaining('started') })
    const child = Number(out.output.match(/child=(\d+)/)![1])
    expect(alive(a.pid) && alive(child)).toBe(true)
    // A "restart": a fresh registry over the same rows re-attaches what still runs.
    const after = createShellRegistry(deps)
    process.kill(-b.pid, 'SIGKILL') // b dies with no exit code while "the worker is down"
    await new Promise(r => setTimeout(r, 200))
    expect(await after.reconcile()).toEqual({ reattached: 1, ended: 1 })
    expect(await shells.get(b.shellId)).toMatchObject({ state: 'lost' })
    // kill_shell: TERM then KILL the whole group — the child dies too.
    expect(await after.kill(WS, a.shellId)).toMatchObject({ state: 'killed' })
    await new Promise(r => setTimeout(r, 300))
    expect(alive(a.pid)).toBe(false)
    expect(alive(child)).toBe(false)
  }, 20_000)

  it.runIf(darwin)('no shell is ever started in an eval world (its commands are confined and reaped)', async () => {
    const { createEvalSandboxManager } = await import('./manager')
    const store = memStore([row(WS)])
    const m = createEvalSandboxManager({ runId: 'r', worldId: 'eval_00000000000040008000000000000ab1_00000003' }, { store, settings: { evalScratchDir: path.join(dir, 'scratch3') }, log: { info: () => {}, warn: () => {}, error: () => {} } })
    const reg = createShellRegistry({ exec: m.exec, peek: m.peek, workspace: (id: string) => store.get(id), store: memShells(), secretValues: async () => [] })
    await expect(reg.start(WS, 'sleep 30')).rejects.toThrow(/background shells are not available: eval worlds/)
  })
})

describe('fix round 1/2: MyMind\'s own readers never follow a planted link, never wedge on a FIFO', () => {
  it('bash_output / the Shells tail: an out file (or a parent) swapped for a symlink reads nothing', async () => {
    const { m, store } = mgr()
    const secret = path.join(outside, `cred-${process.pid}`)
    await writeFile(secret, 'GH_TOKEN_VALUE')
    const dir = await m.ensureDir(WS)
    const SID = '00000000-0000-4000-8000-0000000000f1'
    const shells = (() => {
      const row = { id: SID, workspaceId: WS, command: 'x', state: 'running', exitCode: null, reason: null, readOffset: 0, startedAt: new Date(), endedAt: null } as WorkspaceShellRow
      return { create: async () => row, get: async () => row, listRunning: async () => [row], list: async () => [row], end: async () => true, setOffset: async () => {} } as ShellStore
    })()
    const reg = createShellRegistry({ exec: m.exec, peek: m.peek, workspace: id => store.get(id), store: shells, secretValues: async () => [] })
    await mkdir(path.join(dir, '.mymind/shells', SID), { recursive: true })
    await writeFile(path.join(dir, '.mymind/shells', SID, 'exit'), '0')
    await symlink(secret, path.join(dir, '.mymind/shells', SID, 'out'))
    expect(JSON.stringify(await reg.output(WS, SID).catch((e: Error) => ({ error: e.message })))).not.toContain('GH_TOKEN')
    expect((await reg.tail(WS, SID)).output).not.toContain('GH_TOKEN')
    // A symlinked parent (the shells dir itself) is refused the same way.
    await rm(path.join(dir, '.mymind'), { recursive: true })
    const fake = path.join(outside, `fake-mymind-${process.pid}`)
    await mkdir(path.join(fake, 'shells', SID), { recursive: true })
    await writeFile(path.join(fake, 'shells', SID, 'out'), 'GH_TOKEN_VALUE')
    await writeFile(path.join(fake, 'shells', SID, 'exit'), '0')
    await symlink(fake, path.join(dir, '.mymind'))
    expect(JSON.stringify(await reg.output(WS, SID).catch((e: Error) => ({ error: e.message })))).not.toContain('GH_TOKEN')
    expect((await reg.tail(WS, SID)).output).not.toContain('GH_TOKEN')
  })

  it('export reads in strict mode (a tainted run / workspace): relative paths only, never through a symlink; non-strict reads anywhere', async () => {
    const { m } = mgr()
    const { READ_TEXT_SCRIPT } = await import('./fs-ops')
    const dir = await m.ensureDir(W2)
    const secret = path.join(outside, `cred2-${process.pid}`)
    await writeFile(secret, 'SECRET_KEY')
    await writeFile(path.join(dir, 'ok.md'), '# ok')
    await symlink(secret, path.join(dir, 'link.md'))
    await mkdir(path.join(outside, `d-${process.pid}`), { recursive: true })
    await writeFile(path.join(outside, `d-${process.pid}`, 'x.md'), 'SECRET_KEY')
    await symlink(path.join(outside, `d-${process.pid}`), path.join(dir, 'linkdir'))
    const read = async (p: string, strict: boolean) => JSON.parse((await m.exec(W2, READ_TEXT_SCRIPT, { input: JSON.stringify({ path: p, ...(strict ? { strict: true } : {}) }), internal: true })).stdout)
    expect(await read('ok.md', true)).toMatchObject({ content: '# ok' })
    expect(await read('link.md', true)).toMatchObject({ error: 'symlink' })
    expect(await read('linkdir/x.md', true)).toMatchObject({ error: 'symlink' })
    expect(await read(secret, true)).toMatchObject({ error: 'outside' })
    expect(await read('../x', true)).toMatchObject({ error: 'outside' })
    // Clean runs keep "absolute anywhere" (and links are theirs to follow).
    expect(await read(secret, false)).toMatchObject({ content: 'SECRET_KEY' })
  })
})

describe('fix round 1: minors', () => {
  it('destroyWorkspace kills the workspace\'s shells (onStopped) before removing its dir and row', async () => {
    const onStopped = vi.fn()
    const { m, store } = mgr({ onStopped })
    await m.exec(W2, 'echo x > f')
    await m.destroyWorkspace(W2)
    expect(onStopped).toHaveBeenCalledWith(W2, 'stopped: the workspace was deleted')
    expect(store.rows.has(W2)).toBe(false)
  })

})

describe('fix round 2: a FIFO never wedges MyMind\'s own readers', () => {
  it('export (strict and not) and the shell output reader refuse a FIFO at once instead of blocking until their timeout', async () => {
    const { m, store } = mgr()
    const { READ_TEXT_SCRIPT } = await import('./fs-ops')
    const dir2 = await m.ensureDir(W2)
    await m.exec(W2, 'mkfifo pipe')
    const t0 = Date.now()
    for (const strict of [true, false]) {
      const r = await m.exec(W2, READ_TEXT_SCRIPT, { input: JSON.stringify({ path: 'pipe', ...(strict ? { strict: true } : {}) }), internal: true, timeoutSec: 20 })
      expect(JSON.parse(r.stdout), `strict=${strict}`).toMatchObject({ error: 'not_a_regular_file' })
    }
    const SID = '00000000-0000-4000-8000-0000000000f2'
    await mkdir(path.join(dir2, '.mymind/shells', SID), { recursive: true })
    await writeFile(path.join(dir2, '.mymind/shells', SID, 'exit'), '0')
    await m.exec(W2, `mkfifo .mymind/shells/${SID}/out`)
    const row = { id: SID, workspaceId: W2, command: 'x', state: 'running', exitCode: null, reason: null, readOffset: 0, startedAt: new Date(), endedAt: null } as WorkspaceShellRow
    const shells = { create: async () => row, get: async () => row, listRunning: async () => [row], list: async () => [row], end: async () => true, setOffset: async () => {} } as ShellStore
    const reg = createShellRegistry({ exec: m.exec, peek: m.peek, workspace: id => store.get(id), store: shells, secretValues: async () => [] })
    expect((await reg.tail(W2, SID)).output).toBe('')
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 30_000)
})
