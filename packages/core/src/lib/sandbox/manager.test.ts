// Cycle 82: sandbox manager logic against a fake docker CLI + in-memory store (no Docker needed).
// The real-container behaviour is in test/sandbox.db.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { DockerResult, DockerRunner } from './docker'
import { SANDBOX_BRIDGE, chainRules, jumpRules, ruleLine } from './network'
import { createSandboxManager, sandboxSettings, SandboxUnavailableError, type SandboxManagerOptions } from './manager'
import type { WorkspaceRow, WorkspaceStore } from './store'

const WS = '22222222-2222-2222-2222-222222222222'
const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false })
const fail = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr, timedOut: false, aborted: false, truncated: false })

interface FakeC { Id: string; Name: string; Image: string; State: { Running: boolean }; Config: { Labels: Record<string, string> } }

function fakeDocker(o: { available?: boolean; image?: boolean; net?: Record<string, string> } = {}) {
  const containers = new Map<string, FakeC>()
  const calls: string[][] = []
  let n = 0
  const run: DockerRunner = async (args) => {
    calls.push(args)
    await new Promise(r => setTimeout(r, 1))
    const [a, b] = args
    if (a === 'version') return o.available === false ? fail('Cannot connect') : ok('28.0')
    if (a === 'image') return o.image === false ? fail('No such image') : ok('sha256:img')
    if (a === 'network' && b === 'inspect') return ok(args.includes('{{json .}}') ? JSON.stringify({ Options: o.net ?? { 'com.docker.network.bridge.name': SANDBOX_BRIDGE, 'com.docker.network.bridge.enable_icc': 'false' } }) : 'netid')
    if (a === 'create') {
      const name = args[args.indexOf('--name') + 1]!
      if (containers.has(name)) return fail(`Conflict. The container name "/${name}" is already in use`)
      const labels: Record<string, string> = {}
      args.forEach((x, i) => { if (x === '--label') { const [k, v] = args[i + 1]!.split('='); labels[k!] = v! } })
      containers.set(name, { Id: `cid${++n}`, Name: `/${name}`, Image: 'sha256:img', State: { Running: false }, Config: { Labels: labels } })
      return ok(`cid${n}`)
    }
    if (a === 'container' && b === 'inspect') {
      const found = args.slice(2).map(k => [...containers.values()].find(c => c.Name === `/${k}` || c.Id === k)).filter(Boolean)
      return found.length ? ok(JSON.stringify(found)) : fail('No such container')
    }
    if (a === 'start') { const c = [...containers.values()].find(c => c.Id === b); if (c) c.State.Running = true; return ok() }
    if (a === 'stop') { const c = [...containers.values()].find(c => c.Id === args.at(-1)); if (c) c.State.Running = false; return ok() }
    if (a === 'rm') { for (const [k, c] of containers) if (c.Id === args.at(-1) || k === args.at(-1)) containers.delete(k); return ok() }
    if (a === 'ps') return ok([...containers.values()].map(c => c.Id).join('\n'))
    if (a === 'exec') return args.includes('du -sx -B1 /workspace 2>/dev/null | cut -f1') ? ok('6000000000\n') : ok('hi\n')
    return ok()
  }
  return { run, containers, calls }
}

function memStore(rows: Partial<WorkspaceRow>[] = [{ id: WS }]): WorkspaceStore & { rows: Map<string, WorkspaceRow> } {
  const m = new Map<string, WorkspaceRow>()
  for (const r of rows) m.set(r.id!, { kind: 'home', workstreamId: null, containerId: null, state: 'stopped', bytesUsed: 0, lastUsedAt: new Date(), createdAt: new Date(), deletedAt: null, ...r } as WorkspaceRow)
  return {
    rows: m,
    get: async id => m.get(id) ?? null,
    setContainer: async (id, containerId, state) => { const r = m.get(id); if (r) Object.assign(r, { containerId, state }) },
    touch: async (id) => { const r = m.get(id); if (r) r.lastUsedAt = new Date() },
    setBytes: async (id, b) => { const r = m.get(id); if (r) r.bytesUsed = b },
    listRunning: async () => [...m.values()].filter(r => r.state === 'running' && !r.deletedAt),
    stampOrphans: async () => 0,
    listExpired: async () => [],
    remove: async (id) => { m.delete(id) }
  }
}

const planS = [...jumpRules(), ...chainRules()].map(ruleLine).join('\n')
function mgr(d: ReturnType<typeof fakeDocker>, store = memStore(), extra: Partial<SandboxManagerOptions> = {}) {
  return createSandboxManager({
    docker: d.run, store, iptablesS: async () => planS, uid: 1000, platform: 'darwin',
    settings: { workspacesDir: '/tmp/mm-sbx-unit-never-created', firewall: 'off', dns: [] },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...extra
  })
}

// ensureDir would touch the host fs; the unit tests stub it out via an existing-dir path.
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<typeof import('node:fs/promises')>()), mkdir: vi.fn(async () => undefined), chown: vi.fn(async () => undefined), rmdir: vi.fn(async () => undefined) }))

describe('sandboxSettings', () => {
  it('enforces the firewall on Linux in production even when asked not to', () => {
    expect(sandboxSettings({ NODE_ENV: 'production', SANDBOX_FIREWALL: 'off' }, 'linux').firewall).toBe('enforce')
    expect(sandboxSettings({ NODE_ENV: 'development' }, 'linux').firewall).toBe('enforce')
    expect(sandboxSettings({ NODE_ENV: 'development', SANDBOX_FIREWALL: 'off' }, 'linux').firewall).toBe('off')
    expect(sandboxSettings({}, 'darwin').firewall).toBe('off')
  })
  it('prod defaults: /opt/mymind/.workspaces, public DNS, spec limits', () => {
    const s = sandboxSettings({ NODE_ENV: 'production' }, 'linux')
    expect(s.workspacesDir).toBe('/opt/mymind/.workspaces')
    expect(s.dns).toEqual(['1.1.1.1', '9.9.9.9'])
    expect(s).toMatchObject({ image: 'mymind-sandbox:current', idleMs: 15 * 60_000, quotaBytes: 5 * 1024 ** 3, defaultTimeoutSec: 120, maxTimeoutSec: 600, outputCapBytes: 65536 })
  })
})

describe('preflight fails closed', () => {
  it('no Docker → SandboxUnavailableError, nothing created', async () => {
    const d = fakeDocker({ available: false })
    await expect(mgr(d).ensureContainer(WS)).rejects.toThrow(/Docker is not running/)
    expect(d.calls.some(c => c[0] === 'create')).toBe(false)
  })
  it('missing image → names the build script', async () => {
    await expect(mgr(fakeDocker({ image: false })).ensureContainer(WS)).rejects.toThrow(/build-image\.sh/)
  })
  it('firewall enforce + rules missing → refuses before creating a container', async () => {
    const d = fakeDocker()
    const m = mgr(d, memStore(), { settings: { workspacesDir: '/tmp/x', firewall: 'enforce', dns: [] }, iptablesS: async () => '-P INPUT ACCEPT' })
    await expect(m.ensureContainer(WS)).rejects.toBeInstanceOf(SandboxUnavailableError)
    expect(d.calls.some(c => c[0] === 'create')).toBe(false)
  })
  it('firewall enforce + network made by hand (wrong bridge) → refuses', async () => {
    const d = fakeDocker({ net: { 'com.docker.network.bridge.enable_icc': 'false' } })
    const m = mgr(d, memStore(), { settings: { workspacesDir: '/tmp/x', firewall: 'enforce', dns: [] } })
    await expect(m.ensureContainer(WS)).rejects.toThrow(/firewall/)
  })
  it('firewall enforce + plan in place → creates', async () => {
    const d = fakeDocker()
    const m = mgr(d, memStore(), { settings: { workspacesDir: '/tmp/x', firewall: 'enforce', dns: [] } })
    await m.ensureContainer(WS)
    expect(d.calls.filter(c => c[0] === 'create')).toHaveLength(1)
  })
  it('a deleted / unknown workspace never gets a container', async () => {
    await expect(mgr(fakeDocker(), memStore([{ id: WS, deletedAt: new Date() }])).ensureContainer(WS)).rejects.toThrow(/deleted/)
    await expect(mgr(fakeDocker(), memStore([])).ensureContainer(WS)).rejects.toThrow(/not found/)
  })
})

describe('ensureContainer', () => {
  it('concurrent calls create exactly one container', async () => {
    const d = fakeDocker()
    const m = mgr(d)
    const r = await Promise.all(Array.from({ length: 5 }, () => m.ensureContainer(WS)))
    expect(new Set(r.map(x => x.containerId)).size).toBe(1)
    expect(d.calls.filter(c => c[0] === 'create')).toHaveLength(1)
  })
  it('two managers (two processes) racing → the name conflict is resolved to the one container', async () => {
    const d = fakeDocker()
    const store = memStore()
    const [a, b] = await Promise.all([mgr(d, store).ensureContainer(WS), mgr(d, store).ensureContainer(WS)])
    expect(a.containerId).toBe(b.containerId)
    expect(d.containers.size).toBe(1)
  })
  it('rejects a non-uuid id before touching the host', async () => {
    await expect(mgr(fakeDocker(), memStore([{ id: '../../etc' }])).ensureContainer('../../etc')).rejects.toThrow(/invalid workspace id/)
  })
})

describe('exec', () => {
  it('clamps the timeout to 600s and defaults to 120s', async () => {
    const d = fakeDocker()
    const m = mgr(d)
    await m.exec(WS, 'true', { timeoutSec: 99_999 })
    await m.exec(WS, 'true')
    const execs = d.calls.filter(c => c[0] === 'exec' && c.includes('mm-exec'))
    expect(execs.map(c => c.at(-2))).toEqual(['600', '120'])
  })
  it('refuses secret names that would clobber the base env or are not identifiers', async () => {
    await expect(mgr(fakeDocker()).exec(WS, 'env', { secrets: { PATH: '/evil' } })).rejects.toThrow(/invalid sandbox secret/)
    await expect(mgr(fakeDocker()).exec(WS, 'env', { secrets: { 'A B': 'x' } })).rejects.toThrow(/invalid sandbox secret/)
  })
  it('tainted: a one-off --network none run, no secrets, no long-lived container', async () => {
    const d = fakeDocker()
    const r = await mgr(d).exec(WS, 'curl x', { tainted: true, secrets: { TOKEN: 't' } })
    expect(r.tainted).toBe(true)
    const run = d.calls.find(c => c[0] === 'run')!
    expect(run[run.indexOf('--network') + 1]).toBe('none')
    expect(run.join(' ')).not.toContain('TOKEN')
    expect(d.calls.some(c => c[0] === 'create')).toBe(false)
  })
})

describe('housekeeping', () => {
  it('idle stop: only workspaces unused for 15 min and not busy', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS }, { id: '33333333-3333-3333-3333-333333333333' }, { id: '44444444-4444-4444-4444-444444444444' }])
    const m = mgr(d, store, { isBusy: id => id.startsWith('4') })
    for (const id of store.rows.keys()) await m.ensureContainer(id)
    store.rows.get(WS)!.lastUsedAt = new Date(Date.now() - 16 * 60_000)
    store.rows.get('44444444-4444-4444-4444-444444444444')!.lastUsedAt = new Date(Date.now() - 16 * 60_000)
    expect(await m.idleStop()).toEqual([WS])
    expect(store.rows.get(WS)!.state).toBe('stopped')
    expect(store.rows.get('33333333-3333-3333-3333-333333333333')!.state).toBe('running')
  })
  it('quota tick: over quota → onOverQuota and a refused write', async () => {
    const over = vi.fn()
    const store = memStore()
    const m = mgr(fakeDocker(), store, { onOverQuota: over })
    await m.ensureContainer(WS)
    expect(await m.quotaTick()).toEqual([{ id: WS, bytes: 6_000_000_000, over: true }])
    expect(over).toHaveBeenCalledWith(WS, 6_000_000_000)
    expect(store.rows.get(WS)!.bytesUsed).toBe(6_000_000_000)
    await expect(m.checkQuota(WS)).rejects.toThrow(/over its 5\.0 GB quota/)
  })
  it('reconcile: removes orphans in scope only, repairs rows', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS }])
    const scoped = mgr(d, store, { labels: { 'mymind.test': 'r1' } })
    await scoped.ensureContainer(WS)
    // An orphan in scope (no row), one out of scope (another run), one tainted leftover.
    d.containers.set('mymind-ws-55555555-5555-5555-5555-555555555555', { Id: 'orph', Name: '/mymind-ws-55555555-5555-5555-5555-555555555555', Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': '55555555-5555-5555-5555-555555555555', 'mymind.test': 'r1' } } })
    d.containers.set('other', { Id: 'other', Name: '/mymind-ws-66666666-6666-6666-6666-666666666666', Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': '66666666-6666-6666-6666-666666666666', 'mymind.test': 'r2' } } })
    d.containers.set('taint', { Id: 'taint', Name: '/mymind-wst-x', Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': WS, 'mymind.tainted': '1', 'mymind.test': 'r1' } } })
    const r = await scoped.reconcile()
    expect(r.removed.sort()).toEqual(['orph', 'taint'])
    expect(d.containers.has('other')).toBe(true)
    expect(d.containers.has(`mymind-ws-${WS}`)).toBe(true)
    // Production scope never removes a test-labelled container.
    const prod = mgr(d, store)
    expect((await prod.reconcile()).removed).toEqual([])
    // A row whose container vanished is repaired to stopped.
    d.containers.delete(`mymind-ws-${WS}`)
    expect((await scoped.reconcile()).repaired).toEqual([WS])
    expect(store.rows.get(WS)).toMatchObject({ state: 'stopped', containerId: null })
  })
})

describe('startSandboxHousekeeping', () => {
  it('no Docker → warns once, never reconciles; once up → reconcile once, then idle + quota each tick, sweep daily', async () => {
    vi.useFakeTimers()
    try {
      const { startSandboxHousekeeping } = await import('./manager')
      let up = false
      const calls: string[] = []
      const fake = {
        available: async () => up,
        reconcile: async () => { calls.push('reconcile'); return { removed: [], repaired: [] } },
        idleStop: async () => { calls.push('idle'); return [] },
        quotaTick: async () => { calls.push('quota'); return [] },
        sweep: async () => { calls.push('sweep'); return [] }
      } as unknown as Parameters<typeof startSandboxHousekeeping>[0]
      const warn = vi.fn()
      const stop = startSandboxHousekeeping(fake, { tickMs: 1000, sweepMs: 3000, log: { info: () => {}, warn, error: () => {} } })
      await vi.advanceTimersByTimeAsync(2500)
      expect(calls).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      up = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toEqual(['reconcile', 'idle', 'quota', 'sweep'])
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls.slice(4)).toEqual(['idle', 'quota'])
      stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls.filter(c => c === 'reconcile')).toHaveLength(1)
      expect(calls).toHaveLength(6)
    } finally { vi.useRealTimers() }
  })
})
