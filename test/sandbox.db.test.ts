// Cycle 82 Task 1 — the workspace sandbox against REAL Docker + the dev DB (spec §2, §8).
// Skipped when Docker is not running. Everything this file creates carries the label
// mymind.test=<RUN> (containers) or is tracked by id (rows, dirs) and is removed in afterAll; it
// never touches a container without that label.
//
// What this proves on the dev Mac (Docker Desktop): exact flags on a live container, uid 10001,
// no app env/secrets/mounts, read-only rootfs, no caps, pids limit vs a fork bomb, tainted = no
// network, symlinks resolve inside the container only, quota, idle stop, reconcile, one container
// under concurrency, timeout/abort/output cap. LAN/host blocking needs the Linux firewall: proven
// in test/sandbox-firewall.db.test.ts (docker-in-docker) and in prod acceptance (Task 4).
process.loadEnvFile('.env')
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { workspaces } from '@mymind/core/db/schema'
import { createSandboxManager, containerName, SandboxQuotaError, type SandboxManager } from '@mymind/core/lib/sandbox/manager'
import { dbWorkspaceStore } from '@mymind/core/lib/sandbox/store'

const IMAGE = process.env.SANDBOX_TEST_IMAGE || 'mymind-sandbox:current'
const RUN = `sbx-${process.pid}-${Date.now().toString(36)}`
const LABELS = { 'mymind.test': RUN }

function docker(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const dockerUp = docker('version', '--format', '{{.Server.Version}}').code === 0
const online = dockerUp && (() => {
  const r = spawnSync('curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com'], { encoding: 'utf8' })
  return /^[23]/.test(r.stdout ?? '')
})()

describe.skipIf(!dockerUp)('workspace sandbox (real Docker)', () => {
  const rowIds: string[] = []
  let root = ''
  let m: SandboxManager
  const overQuota: Array<[string, number]> = []

  async function newWorkspace(): Promise<string> {
    const [r] = await useDb().insert(workspaces).values({ kind: 'workstream' }).returning()
    rowIds.push(r!.id)
    return r!.id
  }
  function inspect(id: string) {
    return JSON.parse(docker('container', 'inspect', containerName(id)).out)[0] as {
      Id: string; State: { Running: boolean }; Config: { User: string; Env: string[]; Labels: Record<string, string> }
      HostConfig: { CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[]; PidsLimit: number; Memory: number; MemorySwap: number; NanoCpus: number; ReadonlyRootfs: boolean; Tmpfs: Record<string, string>; NetworkMode: string; Privileged: boolean; Binds: string[] | null }
      Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>
    }
  }
  const mk = (extra: Parameters<typeof createSandboxManager>[0] = {}) => createSandboxManager({
    labels: LABELS,
    settings: { image: IMAGE, workspacesDir: root, firewall: 'off', dns: [], ...extra.settings },
    onOverQuota: (id, b) => { overQuota.push([id, b]) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...extra
  })

  beforeAll(async () => {
    if (docker('image', 'inspect', IMAGE).code !== 0) {
      execFileSync('bash', ['deploy/sandbox/build-image.sh', 'dev'], { stdio: 'inherit', timeout: 900_000 })
    }
    // realpath: on macOS tmpdir() is a /var → /private/var symlink; Docker Desktop shares /private.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-sbx-')))
    m = mk()
  }, 900_000)

  afterAll(async () => {
    const ids = docker('ps', '-aq', '--filter', `label=mymind.test=${RUN}`).out.split('\n').filter(Boolean)
    if (ids.length) docker('rm', '-f', ...ids)
    if (rowIds.length) await useDb().delete(workspaces).where(inArray(workspaces.id, rowIds))
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('runs as uid 10001 with exactly the spec flags', async () => {
    const id = await newWorkspace()
    await m.ensureContainer(id)
    const c = inspect(id)
    expect(c.State.Running).toBe(true)
    expect(c.Config.User).toBe('10001:10001')
    expect(c.HostConfig.CapDrop).toEqual(['ALL'])
    expect(c.HostConfig.CapAdd ?? []).toEqual([])
    expect(c.HostConfig.Privileged).toBe(false)
    expect(c.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
    expect(c.HostConfig.PidsLimit).toBe(512)
    expect(c.HostConfig.Memory).toBe(2 * 1024 ** 3)
    expect(c.HostConfig.MemorySwap).toBe(2 * 1024 ** 3)
    expect(c.HostConfig.NanoCpus).toBe(1_500_000_000)
    expect(c.HostConfig.ReadonlyRootfs).toBe(true)
    expect(Object.keys(c.HostConfig.Tmpfs).sort()).toEqual(['/home/agent', '/tmp'])
    expect(c.HostConfig.NetworkMode).toBe('mymind-sandbox')
    expect(c.Mounts.map(x => [x.Type, x.Source, x.Destination, x.RW])).toEqual([['bind', path.join(root, id), '/workspace', true]])
    expect(c.Config.Labels).toMatchObject({ 'mymind.workspace': id, 'mymind.test': RUN })

    const r = await m.exec(id, 'id -u; id -g; grep -E "^(CapEff|CapPrm|NoNewPrivs)" /proc/self/status; cat /sys/fs/cgroup/pids.max')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.split('\n').slice(0, 2)).toEqual(['10001', '10001'])
    expect(r.stdout).toMatch(/CapPrm:\s+0000000000000000/)
    expect(r.stdout).toMatch(/CapEff:\s+0000000000000000/)
    expect(r.stdout).toMatch(/NoNewPrivs:\s+1/)
    expect(r.stdout.trim().split('\n').at(-1)).toBe('512')
  }, 120_000)

  it('/opt/mymind, the docker socket and the app env are absent; rootfs is read-only', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'ls -d /opt/mymind 2>&1; ls /var/run/docker.sock /run/docker.sock 2>&1; touch /etc/x 2>&1; touch /usr/local/bin/x 2>&1; echo ok > /workspace/f && echo wrote')
    expect(r.stdout).toMatch(/'\/opt\/mymind': No such file/)
    expect(r.stdout).toMatch(/'\/var\/run\/docker\.sock': No such file/)
    expect(r.stdout).toMatch(/'\/run\/docker\.sock': No such file/)
    expect(r.stdout).toMatch(/'\/etc\/x': Read-only file system/)
    expect(r.stdout).toMatch(/'\/usr\/local\/bin\/x': Read-only file system/)
    expect(r.stdout).toContain('wrote')
    // PID 1's env and a command's env: only the allowed vars. (HOSTNAME is set by Docker itself.)
    const env = await m.exec(id, 'tr "\\0" "\\n" < /proc/1/environ | cut -d= -f1 | sort; echo ---; env | cut -d= -f1 | sort')
    const [pid1, cmd] = env.stdout.split('---\n')
    expect(pid1!.trim().split('\n')).toEqual(['HOME', 'HOSTNAME', 'LANG', 'PATH'])
    // `env` itself adds nothing; bash adds its own PWD/SHLVL/_ — none of them carry data in.
    expect(cmd!.trim().split('\n').filter(k => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k))).toEqual(['HOME', 'HOSTNAME', 'LANG', 'PATH'])
    // The worker's own env (loaded from .env: DATABASE_URL etc.) never reaches the sandbox.
    expect(process.env.DATABASE_URL).toBeTruthy()
    const leak = await m.exec(id, 'env; tr "\\0" "\\n" < /proc/1/environ')
    expect(leak.stdout).not.toContain(process.env.DATABASE_URL!)
    expect(leak.stdout).not.toMatch(/DATABASE_URL|BETTER_AUTH|SECRET|TOKEN|API_KEY/)
  }, 120_000)

  it('opted-in secrets reach that command only, never via argv', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'echo "v=$MM_T1_SECRET"', { secrets: { MM_T1_SECRET: 's3cr3t-value' } })
    expect(r.stdout.trim()).toBe('v=s3cr3t-value')
    const again = await m.exec(id, 'echo "v=$MM_T1_SECRET"; tr "\\0" "\\n" < /proc/1/environ')
    expect(again.stdout).toContain('v=\n')
    expect(again.stdout).not.toContain('s3cr3t')
    const tainted = await m.exec(id, 'echo "v=$MM_T1_SECRET"', { tainted: true, secrets: { MM_T1_SECRET: 's3cr3t-value' } })
    expect(tainted.stdout.trim()).toBe('v=')
  }, 120_000)

  it('the sandbox loopback has no Postgres; the internet is reachable', async () => {
    const id = await newWorkspace()
    const pg = await m.exec(id, 'timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/5432" 2>&1; echo "exit=$?"')
    expect(pg.stdout).toMatch(/Connection refused/)
    expect(pg.stdout).not.toContain('exit=0')
    if (!online) return // offline dev box: nothing to assert about the internet
    const web = await m.exec(id, 'curl -sS -m 15 -o /dev/null -w "%{http_code}" https://example.com')
    expect(web.stdout).toMatch(/^[23]\d\d$/)
  }, 120_000)

  it('tainted exec: one-off container, no network at all, same workspace files', async () => {
    const id = await newWorkspace()
    const normal = await m.exec(id, 'echo from-normal > /workspace/shared.txt; awk \'NR>1\' /proc/net/route | wc -l')
    expect(Number(normal.stdout.trim())).toBeGreaterThan(0) // the untainted container does have a route
    const r = await m.exec(id, 'echo "routes=$(awk \'NR>1\' /proc/net/route | wc -l) up=$(cat /sys/class/net/*/operstate 2>/dev/null | grep -vc down)"; cat /workspace/shared.txt; curl -sS -m 5 https://example.com 2>&1; timeout 3 bash -c "echo > /dev/tcp/1.1.1.1/443" 2>&1; echo tainted-write > /workspace/t.txt; id -u', { tainted: true })
    expect(r.tainted).toBe(true)
    expect(r.stdout.split('\n')[0]).toMatch(/^routes=0 up=\d+$/) // --network none: no route anywhere
    expect(r.stdout).toContain('from-normal')
    expect(r.stdout).toMatch(/Could not resolve host|Couldn't resolve/)
    expect(r.stdout).toMatch(/Network is unreachable/)
    expect(r.stdout.trim().split('\n').at(-1)).toBe('10001')
    expect((await m.exec(id, 'cat /workspace/t.txt')).stdout.trim()).toBe('tainted-write')
    // The one-off container is gone (--rm) and only the long-lived one carries this workspace's label.
    const left = docker('ps', '-aq', '--filter', `label=mymind.workspace=${id}`).out.split('\n').filter(Boolean)
    expect(left).toHaveLength(1)
  }, 120_000)

  it('a symlink to an absolute host path resolves inside the container only', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'ln -s /etc/passwd /workspace/pw && ln -s / /workspace/root && cat /workspace/pw | grep -c "^agent:x:10001"; ls /workspace/root/opt 2>&1; ls /workspace/root/Users 2>&1')
    expect(r.stdout.split('\n')[0]).toBe('1') // the CONTAINER's passwd, with the agent user
    expect(r.stdout).toMatch(/\/workspace\/root\/opt\/?:? .*No such file|^$/m)
    expect(r.stdout).toMatch(/Users.*No such file/)
    // On the host it is just a link object inside the workspace dir — nothing on the host follows it.
    const link = path.join(root, id, 'pw')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe('/etc/passwd')
  }, 120_000)

  it('a fork bomb hits the pids limit without affecting the host; the sandbox recovers', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'bomb() { bomb | bomb & }; bomb; sleep 20', { timeoutSec: 8 })
    expect(r.timedOut).toBe(true)
    expect(r.stdout + r.stderr).toMatch(/Resource temporarily unavailable|fork: retry/)
    // The host still forks freely.
    expect(spawnSync('sh', ['-c', 'for i in 1 2 3 4 5; do /bin/echo $i; done'], { encoding: 'utf8' }).stdout.trim().split('\n')).toHaveLength(5)
    // The group kill reaped the bomb; the container answers again.
    let alive = ''
    for (let i = 0; i < 10 && !alive.includes('alive'); i++) {
      alive = (await m.exec(id, 'echo alive; cat /sys/fs/cgroup/pids.current', { timeoutSec: 10 })).stdout
      if (!alive.includes('alive')) await new Promise(res => setTimeout(res, 1000))
    }
    expect(alive).toContain('alive')
    expect(Number(alive.trim().split('\n').at(-1))).toBeLessThan(50)
  }, 180_000)

  it('timeout, abort and the 64 KB tail-kept output cap', async () => {
    const id = await newWorkspace()
    const t0 = Date.now()
    const slow = await m.exec(id, 'sleep 60 & sleep 60', { timeoutSec: 2 })
    expect(slow.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(20_000)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const ab = await m.exec(id, 'sleep 120 & sleep 121', { signal: ac.signal })
    expect(ab.aborted).toBe(true)
    await new Promise(res => setTimeout(res, 1000))
    const ps = await m.exec(id, 'ps -eo args | grep -c "^sleep 12[01]" || true')
    expect(ps.stdout.trim()).toBe('0') // the whole group is gone, background child included
    const big = await m.exec(id, 'seq 1 100000; echo THE-END')
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(64 * 1024)
    expect(big.stdout.trim().endsWith('THE-END')).toBe(true)
  }, 120_000)

  it('quota: over → refused with a clear error and onOverQuota; freeing space clears it', async () => {
    const q = mk({ settings: { image: IMAGE, workspacesDir: root, firewall: 'off', dns: [], quotaBytes: 1024 * 1024 } })
    const id = await newWorkspace()
    await q.exec(id, 'head -c 3000000 /dev/urandom > /workspace/big.bin')
    await expect(q.checkQuota(id)).rejects.toBeInstanceOf(SandboxQuotaError)
    await expect(q.checkQuota(id)).rejects.toThrow(/over its 1\.0 MB quota/)
    overQuota.length = 0
    const tick = await q.quotaTick()
    expect(tick.find(t => t.id === id)).toMatchObject({ over: true })
    expect(overQuota.map(o => o[0])).toContain(id)
    expect((await dbWorkspaceStore.get(id))!.bytesUsed).toBeGreaterThan(1024 * 1024)
    await q.exec(id, 'rm /workspace/big.bin')
    await q.measure(id)
    await expect(q.checkQuota(id)).resolves.toBeUndefined()
  }, 120_000)

  it('idle stop after the idle window; the next command restarts it', async () => {
    const id = await newWorkspace()
    await m.exec(id, 'true')
    expect((await dbWorkspaceStore.get(id))!.state).toBe('running')
    const { eq } = await import('drizzle-orm')
    await useDb().update(workspaces).set({ lastUsedAt: new Date(Date.now() - 16 * 60_000) }).where(eq(workspaces.id, id))
    const stopped = await m.idleStop()
    expect(stopped).toContain(id)
    expect(inspect(id).State.Running).toBe(false)
    expect((await dbWorkspaceStore.get(id))!.state).toBe('stopped')
    expect((await m.exec(id, 'echo back')).stdout.trim()).toBe('back')
    expect(inspect(id).State.Running).toBe(true)
  }, 120_000)

  it('reconcile removes labelled orphans (in scope only) and repairs rows', async () => {
    const id = await newWorkspace()
    await m.ensureContainer(id)
    const ghost = '0e0e0e0e-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12)
    expect(docker('create', '--name', containerName(ghost), '--label', `mymind.workspace=${ghost}`, '--label', `mymind.test=${RUN}`, IMAGE, 'sleep', 'infinity').code).toBe(0)
    const r = await m.reconcile()
    expect(docker('container', 'inspect', containerName(ghost)).code).not.toBe(0)
    expect(r.removed.length).toBeGreaterThanOrEqual(1)
    expect(inspect(id).State.Running).toBe(true)
    // A running row whose container vanished is repaired.
    docker('rm', '-f', containerName(id))
    const r2 = await m.reconcile()
    expect(r2.repaired).toContain(id)
    expect(await dbWorkspaceStore.get(id)).toMatchObject({ state: 'stopped', containerId: null })
  }, 120_000)

  it('concurrent ensureContainer (two managers, many calls) creates exactly one container', async () => {
    const id = await newWorkspace()
    const a = mk()
    const b = mk()
    const res = await Promise.all([a, b, a, b, a, b].map(x => x.ensureContainer(id)))
    expect(new Set(res.map(r => r.containerId)).size).toBe(1)
    const list = docker('ps', '-aq', '--filter', `label=mymind.workspace=${id}`).out.split('\n').filter(Boolean)
    expect(list).toHaveLength(1)
  }, 120_000)

  it('destroyWorkspace empties the dir inside a container, then removes dir, container and row', async () => {
    const id = await newWorkspace()
    await m.exec(id, 'mkdir -p a/b && echo x > a/b/c && chmod 000 a/b/c')
    await m.destroyWorkspace(id)
    expect(() => lstatSync(path.join(root, id))).toThrow()
    expect(docker('container', 'inspect', containerName(id)).code).not.toBe(0)
    expect(await dbWorkspaceStore.get(id)).toBeNull()
  }, 120_000)
})
