// Cycle 82: sandbox manager logic against a fake docker CLI + in-memory store (no Docker needed).
// The real-container behaviour is in test/sandbox.db.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { DockerResult, DockerRunner } from './docker'
import { SANDBOX_BRIDGE, chainRules, jumpRules, ruleLine } from './network'
import { createSandboxManager, sandboxSettings, setSandboxRuntimeHooks, SandboxUnavailableError, type SandboxManagerOptions } from './manager'
import type { WorkspaceRow, WorkspaceStore } from './store'

const WS = '22222222-2222-2222-2222-222222222222'
const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false })
const fail = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr, timedOut: false, aborted: false, truncated: false })

interface FakeC { Id: string; Name: string; Image: string; State: { Running: boolean }; Config: { Labels: Record<string, string> } }

function fakeDocker(o: { available?: boolean; image?: boolean; net?: Record<string, string>; du?: string } = {}) {
  const containers = new Map<string, FakeC>()
  const calls: string[][] = []
  let n = 0
  const run: DockerRunner = async (args) => {
    calls.push(args)
    await new Promise(r => setTimeout(r, 1))
    const [a, b] = args
    if (a === 'version') return o.available === false ? fail('Cannot connect') : ok('28.0')
    if (a === 'info') return ok('{"Driver":"iptables"}')
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
    if (a === 'exec' || a === 'run') return args.some(x => x.includes('du -sx -B1 /workspace')) ? ok(o.du ?? '6000000000\n12\n') : ok('hi\n')
    if (a === 'kill') { const c = [...containers.values()].find(c => c.Id === args.at(-1) || c.Name === `/${args.at(-1)}`); if (c) c.State.Running = false; return ok() }
    return ok()
  }
  return { run, containers, calls }
}

function memStore(rows: Partial<WorkspaceRow>[] = [{ id: WS }]): WorkspaceStore & { rows: Map<string, WorkspaceRow> } {
  const m = new Map<string, WorkspaceRow>()
  for (const r of rows) m.set(r.id!, { kind: 'home', workstreamId: null, containerId: null, state: 'stopped', bytesUsed: 0, inodesUsed: 0, tainted: false, taintedAt: null, lastUsedAt: new Date(), createdAt: new Date(), deletedAt: null, ...r } as WorkspaceRow)
  return {
    rows: m,
    get: async id => m.get(id) ?? null,
    setContainer: async (id, containerId, state) => { const r = m.get(id); if (r) Object.assign(r, { containerId, state }) },
    touch: async (id) => { const r = m.get(id); if (r) r.lastUsedAt = new Date() },
    setUsage: async (id, b, i) => { const r = m.get(id); if (r) { r.bytesUsed = b; r.inodesUsed = i } },
    setTainted: async (id, t) => { const r = m.get(id); if (r) { r.tainted = t; r.taintedAt = t ? new Date() : null } },
    listRunning: async () => [...m.values()].filter(r => r.state === 'running' && !r.deletedAt),
    stampOrphans: async () => 0,
    listExpired: async () => [],
    remove: async (id) => { m.delete(id) }
  }
}

const planS = ['-N DOCKER', '-A FORWARD -j DOCKER-USER', ...[...jumpRules(), ...chainRules()].map(ruleLine)].join('\n')
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
  it('the firewall gate is the explicit flag, never NODE_ENV (review M1)', () => {
    expect(sandboxSettings({ NODE_ENV: 'development' }, 'linux', true).firewall).toBe('enforce')
    expect(sandboxSettings({ NODE_ENV: 'production' }, 'linux', false).firewall).toBe('off')
    expect(sandboxSettings({ NODE_ENV: 'production' }, 'darwin', true).firewall).toBe('enforce')
  })
  it('prod defaults: /opt/mymind/.workspaces, public DNS, spec limits, disk watchdog at 4 GB', () => {
    const s = sandboxSettings({ NODE_ENV: 'production' }, 'linux', true)
    expect(s.workspacesDir).toBe('/opt/mymind/.workspaces')
    expect(s.dns).toEqual(['1.1.1.1', '9.9.9.9'])
    expect(s).toMatchObject({ image: 'mymind-sandbox:current', idleMs: 15 * 60_000, quotaBytes: 5 * 1024 ** 3, quotaInodes: 200_000, minFreeBytes: 4 * 1024 ** 3, defaultTimeoutSec: 120, maxTimeoutSec: 600, outputCapBytes: 65536 })
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
  it('refuses secret names that would clobber the base env, steer the docker CLI or are not identifiers (review M4)', async () => {
    for (const bad of ['PATH', 'HOME', 'DOCKER_HOST', 'docker_context', 'DOCKER_CONFIG', 'LD_PRELOAD', 'HTTPS_PROXY', 'https_proxy', 'GODEBUG', 'A B', '1X']) {
      const d = fakeDocker()
      await expect(mgr(d).exec(WS, 'env', { secrets: { [bad]: 'x' } })).rejects.toThrow(/invalid sandbox secret/)
      expect(d.calls.some(c => c[0] === 'exec' || c[0] === 'create')).toBe(false)
    }
    await expect(mgr(fakeDocker()).exec(WS, 'env', { secrets: { GITHUB_TOKEN: 'x', GOOGLE_API_KEY: 'y' } })).resolves.toBeTruthy()
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
  it('taint is persistent (review I1): kills the networked container, flags the row, later untainted commands stay offline', async () => {
    const d = fakeDocker()
    const store = memStore()
    const m = mgr(d, store)
    await m.exec(WS, 'echo hi', { secrets: { TOKEN: 't' } })
    const cid = store.rows.get(WS)!.containerId!
    expect(d.containers.get(`mymind-ws-${WS}`)!.State.Running).toBe(true)
    await m.exec(WS, 'cat evil', { tainted: true })
    // Order: flag first (nothing networked can start), then the kill.
    expect(store.rows.get(WS)).toMatchObject({ tainted: true, state: 'stopped' })
    expect(d.containers.get(`mymind-ws-${WS}`)!.State.Running).toBe(false)
    expect(d.calls.some(c => c[0] === 'kill' && c[1] === cid)).toBe(true)
    d.calls.length = 0
    const later = await m.exec(WS, 'curl x', { secrets: { TOKEN: 't' } })
    expect(later.tainted).toBe(true)
    expect(d.calls.some(c => c[0] === 'start' || c[0] === 'create' || (c[0] === 'exec' && c.includes('mm-exec')))).toBe(false)
    const run = d.calls.find(c => c[0] === 'run')!
    expect(run[run.indexOf('--network') + 1]).toBe('none')
    expect(run.join(' ')).not.toContain('TOKEN')
    await expect(m.ensureContainer(WS)).rejects.toThrow(/tainted/)
    // Re-enabled (the API flips the flag) → networked again.
    store.rows.get(WS)!.tainted = false
    expect((await m.exec(WS, 'echo back')).tainted).toBe(false)
    expect(d.containers.get(`mymind-ws-${WS}`)!.State.Running).toBe(true)
  })
  it('taint fails closed when the networked container cannot be stopped', async () => {
    const d = fakeDocker()
    const m = mgr(d)
    await m.exec(WS, 'true')
    const orig = d.run
    const stuck: typeof d.run = async (args, o) => args[0] === 'kill' ? fail('permission denied') : orig(args, o)
    const m2 = createSandboxManager({ docker: stuck, store: memStore([{ id: WS, state: 'running' }]), uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } })
    await expect(m2.exec(WS, 'cat evil', { tainted: true })).rejects.toThrow(/could not stop the networked sandbox/)
    expect(d.calls.some(c => c[0] === 'run')).toBe(false)
  })
  it('a container with a stale isolation-flags hash is recreated (review M6)', async () => {
    const d = fakeDocker()
    const m = mgr(d)
    await m.ensureContainer(WS)
    d.containers.get(`mymind-ws-${WS}`)!.Config.Labels['mymind.flags'] = 'old'
    await m.ensureContainer(WS)
    expect(d.calls.filter(c => c[0] === 'create')).toHaveLength(2)
    expect(d.calls.some(c => c[0] === 'rm')).toBe(true)
  })
  it('reports an OOM kill as oom, not as a timeout (review M10)', async () => {
    const d = fakeDocker()
    const orig = d.run
    const run: typeof d.run = async (args, o) => args[0] === 'exec' && args.includes('mm-exec')
      ? { code: 137, stdout: '', stderr: 'Killed\n__mm_status__:oom\n', timedOut: false, aborted: false, truncated: false }
      : orig(args, o)
    const r = await createSandboxManager({ docker: run, store: memStore(), uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } }).exec(WS, 'big')
    expect(r).toMatchObject({ oom: true, timedOut: false, stderr: 'Killed', exitCode: 137 })
  })
  it('hard-kill fallback: restarts an untainted container at the pids limit, only kills a tainted one (rereview #2, #4)', async () => {
    for (const tainted of [false, true]) {
      const d = fakeDocker()
      const store = memStore()
      const m0 = mgr(d, store)
      await m0.ensureContainer(WS)
      const orig = d.run
      const calls: string[][] = []
      const run: typeof d.run = async (args, o) => {
        calls.push(args)
        // The kill-exec can't fork (pids limit); the exec CLI is killed by the abort signal.
        if (args[0] === 'exec' && args.at(-1)!.includes('.abort')) return fail('OCI runtime exec failed: resource temporarily unavailable', 126)
        if (args[0] === 'exec' && args.includes('mm-exec')) {
          if (tainted) store.rows.get(WS)!.tainted = true // the taint landed while this exec ran
          await new Promise<void>(r => o?.signal?.addEventListener('abort', () => r(), { once: true }))
          return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }
        }
        return orig(args, o)
      }
      const m = createSandboxManager({ docker: run, store, uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } })
      const ac = new AbortController()
      const p = m.exec(WS, ':(){ :|:& };:', { signal: ac.signal })
      await new Promise(r => setTimeout(r, 20))
      ac.abort()
      expect((await p).aborted).toBe(true)
      await new Promise(r => setTimeout(r, 30))
      expect(calls.some(c => c[0] === 'restart')).toBe(!tainted)
      expect(calls.some(c => c[0] === 'kill' && c[1] === `mymind-ws-${WS}`)).toBe(tainted)
    }
  })
  it('re-enable (rereview #5): aborts every tainted run in flight and removes tainted one-offs BEFORE clearing the flag', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS, tainted: true }])
    const orig = d.run
    const order: string[] = []
    let release!: () => void
    const run: typeof d.run = async (args, o) => {
      if (args[0] === 'run' && args.includes('mymind.tainted=1')) {
        const name = args[args.indexOf('--name') + 1]!
        d.containers.set(name, { Id: name, Name: `/${name}`, Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': WS, 'mymind.tainted': '1' } } })
        await new Promise<void>((r) => { release = r; o?.signal?.addEventListener('abort', () => r(), { once: true }) })
        d.containers.delete(name)
        order.push('one-off ended')
        return { code: 137, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }
      }
      if (args[0] === 'kill' || args[0] === 'rm') { order.push(`${args[0]}`); const c = d.containers.get(args.at(-1)!); if (c) { d.containers.delete(args.at(-1)!); release?.() } }
      return orig(args, o)
    }
    const origSet = store.setTainted
    store.setTainted = async (id, t) => { order.push(`tainted=${t}`); return origSet(id, t) }
    const m = createSandboxManager({ docker: run, store, uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } })
    const pending = m.exec(WS, 'sleep 100 && echo evil > f')
    await new Promise(r => setTimeout(r, 30))
    const row = await m.reenableNetwork(WS)
    expect(row.tainted).toBe(false)
    const r = await pending
    expect(r.tainted).toBe(true)
    expect(order.indexOf('one-off ended')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('one-off ended')).toBeLessThan(order.indexOf('tainted=false'))
  })
  it('re-enable fails closed (flag kept) when a tainted one-off will not go away', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS, tainted: true }])
    d.containers.set('stuck', { Id: 'stuck', Name: '/mymind-wst-x', Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': WS, 'mymind.tainted': '1' } } })
    const orig = d.run
    const run: typeof d.run = async (args, o) => args[0] === 'rm' ? fail('device busy') : orig(args, o)
    vi.useFakeTimers()
    try {
      const m = createSandboxManager({ docker: run, store, uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } })
      const p = m.reenableNetwork(WS)
      const caught = p.catch(e => e as Error)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(((await caught) as Error).message).toMatch(/network stays off/)
    } finally { vi.useRealTimers() }
    expect(store.rows.get(WS)!.tainted).toBe(true)
  })
  it('passes the abort signal to the docker CLI and kills the group with a tombstone (review M5)', async () => {
    const d = fakeDocker()
    let seen: AbortSignal | undefined
    const orig = d.run
    const run: typeof d.run = async (args, o) => {
      if (args[0] === 'exec' && args.includes('mm-exec')) { seen = o?.signal; await new Promise(r => setTimeout(r, 30)); return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false } }
      return orig(args, o)
    }
    const ac = new AbortController()
    const p = createSandboxManager({ docker: run, store: memStore(), uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: { info: () => {}, warn: () => {}, error: () => {} } }).exec(WS, 'sleep 100', { signal: ac.signal })
    await new Promise(r => setTimeout(r, 15))
    ac.abort()
    const r = await p
    expect(r.aborted).toBe(true)
    expect(seen).toBe(ac.signal)
    const kill = d.calls.find(c => c[0] === 'exec' && c.at(-1)!.includes('.abort'))!
    expect(kill.at(-1)).toMatch(/: > "\$d\/[a-z0-9-]+\.abort"; read p/)
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
    expect(await m.quotaTick()).toEqual([{ id: WS, bytes: 6_000_000_000, inodes: 12, over: true }])
    expect(over).toHaveBeenCalledWith(WS, { bytes: 6_000_000_000, inodes: 12 })
    expect(store.rows.get(WS)!.bytesUsed).toBe(6_000_000_000)
    await expect(m.checkQuota(WS)).rejects.toThrow(/over its 5\.0 GB quota/)
  })
  it('low-inode watchdog (rereview #1): free inodes under max(200k, 5%) is an episode; recovery needs max(250k, 7%)', async () => {
    const d = fakeDocker()
    const store = memStore()
    let st = { freeBytes: 50 * 1024 ** 3, freeInodes: 2_000_000, totalInodes: 10_000_000 }
    const m = mgr(d, store, { fsStats: async () => st })
    await m.ensureContainer(WS)
    expect(await m.diskCheck()).toMatchObject({ low: false })
    st = { ...st, freeInodes: 450_000 } // 4.5% of 10M: under the 5% floor though > 200k
    expect(await m.diskCheck()).toMatchObject({ low: true, entered: true, reason: 'inodes', stopped: [WS] })
    await expect(m.exec(WS, 'echo')).rejects.toThrow(/low on free files/)
    st = { ...st, freeInodes: 600_000 } // 6%: above the floor, below the 7% resume level
    expect(await m.diskCheck()).toMatchObject({ low: true, recovered: false })
    st = { ...st, freeInodes: 800_000 }
    expect(await m.diskCheck()).toMatchObject({ low: false, recovered: true })
    // A filesystem without a fixed inode table (ZFS: total 0) never trips the inode floor.
    st = { freeBytes: 50 * 1024 ** 3, freeInodes: 0, totalInodes: 0 }
    expect(await m.diskCheck()).toMatchObject({ low: false })
    // Small absolute floor: 150k free of 1M total (15%) is still under 200k.
    st = { freeBytes: 50 * 1024 ** 3, freeInodes: 150_000, totalInodes: 1_000_000 }
    expect(await m.diskCheck()).toMatchObject({ low: true, reason: 'inodes' })
  })
  it('a measurement that fails or times out counts as OVER quota (rereview #1, fail closed)', async () => {
    const over = vi.fn()
    const store = memStore()
    const m = mgr(fakeDocker({ du: '' }), store, { onOverQuota: over })
    await m.ensureContainer(WS)
    const t = await m.quotaTick()
    expect(t[0]).toMatchObject({ id: WS, over: true })
    expect(over).toHaveBeenCalledTimes(1)
    await expect(m.checkQuota(WS)).rejects.toThrow(/could not be measured/)
  })
  it('quota tick: too many files is over quota too (review I2)', async () => {
    const store = memStore()
    const m = mgr(fakeDocker({ du: '1000\n250000\n' }), store)
    await m.ensureContainer(WS)
    expect(await m.quotaTick()).toEqual([{ id: WS, bytes: 1000, inodes: 250_000, over: true }])
    expect(store.rows.get(WS)!.inodesUsed).toBe(250_000)
    await expect(m.checkQuota(WS)).rejects.toThrow(/200,000-file quota/)
  })
  it('a tainted workspace is measured in a one-off no-network container', async () => {
    const d = fakeDocker({ du: '10\n2\n' })
    const store = memStore([{ id: WS, tainted: true }])
    await mgr(d, store).checkQuota(WS)
    const run = d.calls.find(c => c[0] === 'run')!
    expect(run[run.indexOf('--network') + 1]).toBe('none')
    expect(d.calls.some(c => c[0] === 'create')).toBe(false)
    expect(store.rows.get(WS)).toMatchObject({ bytesUsed: 10, inodesUsed: 2 })
  })
  it('low-disk watchdog (review I2): stops every sandbox in scope, refuses commands, recovers with hysteresis', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS }, { id: '33333333-3333-3333-3333-333333333333' }])
    const over = vi.fn()
    let free = 50 * 1024 ** 3
    const m = mgr(d, store, { onOverQuota: over, fsStats: async () => ({ freeBytes: free, freeInodes: 10_000_000, totalInodes: 20_000_000 }), labels: { 'mymind.test': 'r1' } })
    await m.ensureContainer(WS)
    await m.ensureContainer('33333333-3333-3333-3333-333333333333')
    // An out-of-scope container (another test run) is never touched.
    d.containers.set('other', { Id: 'other', Name: '/mymind-ws-x', Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': '66666666-6666-6666-6666-666666666666', 'mymind.test': 'r2' } } })
    expect(await m.diskCheck()).toMatchObject({ low: false, entered: false })
    free = 3 * 1024 ** 3
    const r = await m.diskCheck()
    expect(r).toMatchObject({ low: true, entered: true })
    expect(r.stopped.sort()).toEqual([WS, '33333333-3333-3333-3333-333333333333'].sort())
    expect([...d.containers.values()].filter(c => c.Id !== 'other').every(c => !c.State.Running)).toBe(true)
    expect(d.containers.get('other')!.State.Running).toBe(true)
    expect(store.rows.get(WS)!.state).toBe('stopped')
    expect(over).toHaveBeenCalledTimes(2)
    await expect(m.exec(WS, 'echo')).rejects.toThrow(/low on disk/)
    await expect(m.checkQuota(WS)).rejects.toThrow(/low on disk/)
    // Still low: no second episode — but every check re-kills whatever slipped in (rereview #3).
    d.containers.get(`mymind-ws-${WS}`)!.State.Running = true
    const again = await m.diskCheck()
    expect(again).toMatchObject({ low: true, entered: false })
    expect(again.stopped).toContain(WS)
    expect(d.containers.get(`mymind-ws-${WS}`)!.State.Running).toBe(false)
    expect(d.containers.get('other')!.State.Running).toBe(true)
    free = 4.5 * 1024 ** 3
    expect(await m.diskCheck()).toMatchObject({ low: true, recovered: false })
    free = 6 * 1024 ** 3
    expect(await m.diskCheck()).toMatchObject({ low: false, recovered: true })
    expect((await m.exec(WS, 'echo')).exitCode).toBe(0)
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
    // The networked container of a tainted workspace is removed too.
    store.rows.get(WS)!.tainted = true
    const netId = d.containers.get(`mymind-ws-${WS}`)!.Id
    expect((await scoped.reconcile()).removed).toEqual([netId])
    store.rows.get(WS)!.tainted = false
    await scoped.ensureContainer(WS)
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
        sweep: async () => { calls.push('sweep'); return [] },
        diskCheck: async () => ({ freeBytes: 1, freeInodes: 1, reason: null, low: false, entered: false, recovered: false, stopped: [] }),
        isDiskLow: () => false
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

describe('startSandboxHousekeeping — disk watchdog', () => {
  it('checks every 5s and reports a low-disk episode exactly once', async () => {
    vi.useFakeTimers()
    try {
      const { startSandboxHousekeeping } = await import('./manager')
      let n = 0
      const fake = {
        available: async () => false,
        diskCheck: async () => { n++; return { freeBytes: 1, freeInodes: 1, reason: 'bytes', low: n >= 2, entered: n === 2, recovered: false, stopped: ['a'] } },
        isDiskLow: () => n >= 2
      } as unknown as Parameters<typeof startSandboxHousekeeping>[0]
      const onLowDisk = vi.fn()
      const stop = startSandboxHousekeeping(fake, { onLowDisk, log: { info: () => {}, warn: () => {}, error: () => {} } })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(n).toBe(5) // t=0,5,10,15,20
      expect(onLowDisk).toHaveBeenCalledTimes(1)
      stop()
    } finally { vi.useRealTimers() }
  })
})

describe('diskCheck with the real statfs', () => {
  it('reads free bytes and inodes of the workspaces filesystem (dir need not exist yet)', async () => {
    const m = mgr(fakeDocker(), memStore(), { settings: { workspacesDir: '/tmp/mm-sbx-does-not-exist/x/y', firewall: 'off', dns: [], minFreeBytes: 1, resumeFreeBytes: 1, minFreeInodes: 1, minFreeInodesRatio: 0 } })
    const r = await m.diskCheck()
    expect(r.low).toBe(false)
    expect(r.freeBytes).toBeGreaterThan(0)
    expect(r.freeInodes).toBeGreaterThan(0)
  })
})

// ── Task 2 carry-overs (task-1 rereview minors 1, 3, 4) + the runtime hooks ──────────────────────
describe('task 2 carry-overs', () => {
  const quiet = { info: () => {}, warn: () => {}, error: () => {} }
  it('re-enable vs a tainted one-off whose creation raced the abort: the flag clears only after the docker run returned, and the command never ran', async () => {
    const d = fakeDocker()
    const store = memStore([{ id: WS, tainted: true }])
    const orig = d.run
    const order: string[] = []
    const run: typeof d.run = async (args, o) => {
      if (args[0] === 'run' && args.includes('mymind.tainted=1')) {
        const name = args[args.indexOf('--name') + 1]!
        // The daemon is slow: the container exists only 80ms after the CLI started — after the abort's
        // first kill already failed with "No such container".
        await new Promise(r => setTimeout(r, 80))
        d.containers.set(name, { Id: name, Name: `/${name}`, Image: 'sha256:img', State: { Running: true }, Config: { Labels: { 'mymind.workspace': WS, 'mymind.tainted': '1' } } })
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 25))
          if (!d.containers.has(name)) { order.push('one-off ended (killed)'); return { code: 137, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false } }
        }
        order.push('EVIL RAN'); d.containers.delete(name)
        return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false }
      }
      if (args[0] === 'kill') { const n = args.at(-1)!; if (!d.containers.has(n)) return fail(`No such container: ${n}`); d.containers.delete(n); return ok() }
      return orig(args, o)
    }
    const origSet = store.setTainted
    store.setTainted = async (id, t) => { order.push(`tainted=${t}`); return origSet(id, t) }
    const m = createSandboxManager({ docker: run, store, uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: quiet })
    const pending = m.exec(WS, 'sleep 1; echo evil > f')
    await new Promise(r => setTimeout(r, 10))
    const row = await m.reenableNetwork(WS)
    expect(row.tainted).toBe(false)
    await pending
    expect(order).not.toContain('EVIL RAN')
    expect(order.indexOf('one-off ended (killed)')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('one-off ended (killed)')).toBeLessThan(order.indexOf('tainted=false'))
  })

  it('hard-kill during a low-disk episode kills the container instead of restarting it', async () => {
    const d = fakeDocker()
    const store = memStore()
    let free = 50 * 1024 ** 3
    const opts = { fsStats: async () => ({ freeBytes: free, freeInodes: 10_000_000, totalInodes: 20_000_000 }) }
    const m0 = mgr(d, store, opts)
    await m0.ensureContainer(WS)
    const orig = d.run
    const calls: string[][] = []
    const run: typeof d.run = async (args, o) => {
      calls.push(args)
      if (args[0] === 'exec' && args.at(-1)!.includes('.abort')) return fail('OCI runtime exec failed: resource temporarily unavailable', 126)
      if (args[0] === 'exec' && args.includes('mm-exec')) {
        await new Promise<void>(r => o?.signal?.addEventListener('abort', () => r(), { once: true }))
        return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false }
      }
      return orig(args, o)
    }
    const m = createSandboxManager({ docker: run, store, uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: quiet, ...opts })
    const ac = new AbortController()
    const p = m.exec(WS, ':(){ :|:& };:', { signal: ac.signal })
    await new Promise(r => setTimeout(r, 20))
    free = 1024 ** 3
    expect((await m.diskCheck()).entered).toBe(true)
    ac.abort()
    await p
    await new Promise(r => setTimeout(r, 30))
    expect(calls.some(c => c[0] === 'restart')).toBe(false)
    expect(calls.some(c => c[0] === 'kill' && c[1] === `mymind-ws-${WS}`)).toBe(true)
  })

  it('isBusy may be async (DB-backed shells/watches); a failing busy check never stops the workspace', async () => {
    for (const isBusy of [async () => true, async () => { throw new Error('db down') }]) {
      const d = fakeDocker()
      const store = memStore()
      const m = mgr(d, store, { isBusy })
      await m.ensureContainer(WS)
      store.rows.get(WS)!.lastUsedAt = new Date(Date.now() - 16 * 60_000)
      expect(await m.idleStop()).toEqual([])
      expect(store.rows.get(WS)!.state).toBe('running')
    }
  })

  it('the runtime hooks installed at worker start apply to a manager built without them', async () => {
    const busy = vi.fn(async () => true)
    const over = vi.fn()
    setSandboxRuntimeHooks({ isBusy: busy, onOverQuota: over })
    try {
      const d = fakeDocker()
      const store = memStore()
      const m = mgr(d, store)
      await m.ensureContainer(WS)
      store.rows.get(WS)!.lastUsedAt = new Date(Date.now() - 16 * 60_000)
      expect(await m.idleStop()).toEqual([])
      expect(busy).toHaveBeenCalledWith(WS)
      await m.quotaTick()
      expect(over).toHaveBeenCalledWith(WS, { bytes: 6_000_000_000, inodes: 12 })
    } finally { setSandboxRuntimeHooks({ isBusy: undefined, onOverQuota: undefined }) }
  })

  it('stdin and the output cap reach the docker CLI (networked exec and tainted one-off)', async () => {
    const d = fakeDocker()
    const seen: Array<{ verb: string; input?: string; cap?: number }> = []
    const orig = d.run
    const run: typeof d.run = async (args, o) => {
      if (args.includes('mm-exec')) seen.push({ verb: args[0]!, input: o?.input, cap: o?.capBytes })
      return orig(args, o)
    }
    const m = createSandboxManager({ docker: run, store: memStore(), uid: 1000, platform: 'darwin', settings: { workspacesDir: '/tmp/x', firewall: 'off', dns: [] }, log: quiet })
    await m.exec(WS, 'cat > f', { input: 'BODY', capBytes: 200_000 })
    await m.exec(WS, 'cat > f', { input: 'BODY2', tainted: true, capBytes: 50 * 1024 ** 2 })
    expect(seen).toEqual([{ verb: 'exec', input: 'BODY', cap: 200_000 }, { verb: 'run', input: 'BODY2', cap: 1024 * 1024 }])
  })
})
