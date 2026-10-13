// Cycle 86 Task 1 — the host workspace manager against real processes and an in-memory store:
// relative / absolute paths, secrets, the taint-confinement switch (on → confined + activity; off →
// unconfined, still no secrets), persistent workspace taint + re-enable, the eval world (always
// confined, whatever the switch), the low-disk alarm, the idle stop, and background shells as
// process groups (kill, restart re-attach / lost).
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
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

function mgr(o: Partial<SandboxManagerOptions> & { switchOn?: boolean } = {}) {
  const store = memStore([row(WS), row(W2)])
  const recorded: Array<{ name: string; meta?: Record<string, unknown> }> = []
  const onTainted = vi.fn()
  const m = createSandboxManager({
    store,
    settings: { workspacesDir: path.join(dir, `m-${Math.random().toString(36).slice(2, 8)}`) },
    taintConfinement: async () => o.switchOn ?? true,
    record: e => { recorded.push({ name: e.name, meta: e.meta as Record<string, unknown> }) },
    env: { HOME: os.homedir(), USER: 'bridget', PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', DATABASE_URL: 'postgres://worker-only' },
    onTainted,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...o
  })
  return { m, store, recorded, onTainted }
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

  it('a command never sees the worker\'s env; opted-in secrets reach a clean command only', async () => {
    const { m } = mgr({ switchOn: false })
    const clean = await m.exec(WS, 'echo "db=[$DATABASE_URL] tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' } })
    expect(clean.stdout).toBe('db=[] tok=[tok-123]\n')
    const tainted = await m.exec(W2, 'echo "tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' }, tainted: true })
    expect(tainted.stdout).toBe('tok=[]\n') // switch off: unconfined, but still no secrets
    const offline = await m.exec(WS, 'echo "tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' }, offline: true })
    expect(offline.stdout).toBe('tok=[]\n')
    const internal = await m.exec(WS, 'echo "tok=[$GH_TOKEN]"', { secrets: { GH_TOKEN: 'tok-123' }, internal: true })
    expect(internal.stdout).toBe('tok=[]\n')
    await expect(m.exec(WS, 'true', { secrets: { PATH: '/evil' } })).rejects.toThrow(/invalid sandbox secret name/)
  })
})

describe('the taint-confinement switch', () => {
  it('switch OFF: a tainted run\'s command is unconfined (no activity, no chip), the workspace is still marked tainted, its result flagged', async () => {
    const { m, store, recorded, onTainted } = mgr({ switchOn: false })
    const r = await m.exec(WS, `echo x > ${JSON.stringify(path.join(outside, 'off.txt'))}`, { tainted: true })
    expect(r).toMatchObject({ exitCode: 0, tainted: true })
    expect(r.confined).toBeUndefined()
    expect(recorded).toEqual([])
    expect(onTainted).not.toHaveBeenCalled()
    expect(store.rows.get(WS)!.tainted).toBe(true)
    expect(await m.confinementFor(WS)).toBeNull()
  })

  it('confinement needs macOS: with the switch on, a tainted command is refused elsewhere (fail closed)', async () => {
    const { m } = mgr({ platform: 'linux' })
    await expect(m.exec(WS, 'true', { tainted: true })).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(m.exec(W2, 'true', { offline: true })).rejects.toThrow(/needs macOS sandbox-exec/)
    expect((await m.exec(W2, 'echo ok')).stdout).toBe('ok\n') // clean: unaffected
  })

  it.runIf(darwin)('switch ON: tainted run → confined (activity + note), workspace tainted and its shells killed; later clean commands confined until re-enabled', async () => {
    const { m, store, recorded, onTainted } = mgr({ switchOn: true })
    const target = path.join(outside, 'on.txt')
    const r = await m.exec(WS, `echo in > in.txt; echo out > ${JSON.stringify(target)}`, { tainted: true, audit: { tool: 'bash', runId: 'run-1' } })
    expect(r).toMatchObject({ tainted: true, confined: { reason: 'tainted-run' } })
    expect(r.stderr).toMatch(/Operation not permitted/)
    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/)
    expect(await readFile(path.join(m.hostDir(WS), 'in.txt'), 'utf8')).toBe('in\n')
    expect(recorded).toEqual([{ name: 'sandbox:confined', meta: { workspaceId: WS, reason: 'tainted-run', tool: 'bash', runId: 'run-1' } }])
    expect(onTainted).toHaveBeenCalledWith(WS)
    expect(store.rows.get(WS)!.tainted).toBe(true)
    // Persistent: a CLEAN run's command in this workspace is confined too.
    expect(await m.confinementFor(WS)).toBe('tainted-workspace')
    const later = await m.exec(WS, 'echo hi')
    expect(later).toMatchObject({ stdout: 'hi\n', tainted: true, confined: { reason: 'tainted-workspace' } })
    // MyMind's own fixed scripts are never confined (the UI / shell kills must reach the real thing)…
    const internal = await m.exec(WS, 'echo ui', { internal: true })
    expect(internal.confined).toBeUndefined()
    expect(internal.tainted).toBe(true) // …but their results still carry the taint.
    // Re-enable: clean again.
    await m.reenableNetwork(WS)
    expect(store.rows.get(WS)!.tainted).toBe(false)
    expect((await m.exec(WS, 'echo ok')).confined).toBeUndefined()
  })

  it.runIf(darwin)('switch ON: an unverified-only run is confined but never marks the workspace', async () => {
    const { m, store, recorded } = mgr({ switchOn: true })
    const r = await m.exec(W2, 'echo x', { offline: true })
    expect(r).toMatchObject({ offline: true, tainted: false, confined: { reason: 'unverified' } })
    expect(store.rows.get(W2)!.tainted).toBe(false)
    expect(recorded.map(e => e.meta?.reason)).toEqual(['unverified'])
  })

  it.runIf(darwin)('re-enable aborts a confined command in flight and waits for it before clearing the flag', async () => {
    const { m, store } = mgr({ switchOn: true })
    const running = m.exec(WS, 'sleep 30', { tainted: true })
    await new Promise(r => setTimeout(r, 300))
    await m.reenableNetwork(WS)
    const r = await running
    expect(r.aborted).toBe(true)
    expect(store.rows.get(WS)!.tainted).toBe(false)
  })
})

describe('eval worlds: always confined, whatever the switch', () => {
  it.runIf(darwin)('switch OFF and a clean run: still confined to the world dir, offline, no secrets allowed', async () => {
    const { createEvalSandboxManager } = await import('./manager')
    const store = memStore([row(WS)])
    const recorded: string[] = []
    const scratch = path.join(dir, 'scratch')
    const m = createEvalSandboxManager({ runId: 'r', worldId: 'eval_00000000000040008000000000000ab1_00000001' }, {
      store, taintConfinement: async () => false, settings: { evalScratchDir: scratch }, record: e => { recorded.push(String((e.meta as { reason?: string }).reason)) },
      log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    expect(m.offline).toBe(true)
    const r = await m.exec(WS, `echo in > in.txt; echo "home=$HOME"; echo out > ${JSON.stringify(path.join(outside, 'eval.txt'))}`)
    expect(r.confined).toEqual({ reason: 'eval' })
    expect(r.stdout).toContain(`home=${await realpath(path.join(scratch, 'eval_00000000000040008000000000000ab1_00000001'))}/.home`)
    expect(r.stderr).toMatch(/Operation not permitted/)
    await expect(readFile(path.join(outside, 'eval.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    // Even MyMind's own scripts run confined in a world.
    expect((await m.exec(WS, 'true', { internal: true })).confined).toEqual({ reason: 'eval' })
    await expect(m.exec(WS, 'true', { secrets: { GH_TOKEN: 'x' } })).rejects.toThrow(/never available in an eval world/)
    expect(recorded).toEqual(['eval', 'eval'])
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

  it.runIf(darwin)('a shell is never started for a command that would run confined', async () => {
    const { m, store } = mgr({ switchOn: true })
    const reg = createShellRegistry({ exec: m.exec, peek: m.peek, workspace: (id: string) => store.get(id), store: memShells(), secretValues: async () => [] })
    await expect(reg.start(WS, 'sleep 30', { tainted: true })).rejects.toThrow(/not available while commands run confined/)
  })
})

describe('fix round 1: MyMind\'s own (unconfined) readers never follow a planted link', () => {
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
    await expect(reg.output(WS, SID)).rejects.toThrow(/could not read the shell's output/)
    expect((await reg.tail(WS, SID)).output).not.toContain('GH_TOKEN')
    // A symlinked parent (the shells dir itself) is refused the same way.
    await rm(path.join(dir, '.mymind'), { recursive: true })
    const fake = path.join(outside, `fake-mymind-${process.pid}`)
    await mkdir(path.join(fake, 'shells', SID), { recursive: true })
    await writeFile(path.join(fake, 'shells', SID, 'out'), 'GH_TOKEN_VALUE')
    await writeFile(path.join(fake, 'shells', SID, 'exit'), '0')
    await symlink(fake, path.join(dir, '.mymind'))
    await expect(reg.output(WS, SID)).rejects.toThrow(/could not read the shell's output/)
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

  it.runIf(darwin)('a clean command issued while a taint is landing reads the flag under the lock — it runs confined', async () => {
    const { m, store } = mgr({ switchOn: true })
    // Slow the taint's own write so the race window is wide open.
    const realSet = store.setTainted
    store.setTainted = async (id, t) => { await new Promise(r => setTimeout(r, 50)); return realSet(id, t) }
    const tainting = m.markTainted(WS)
    const clean = m.exec(WS, 'echo hi')
    await tainting
    expect((await clean).confined).toEqual({ reason: 'tainted-workspace' })
  })
})
