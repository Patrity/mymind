// Cycle 82 Task 1 — the workspace sandbox against REAL Docker + the dev DB (spec §2, §8).
// Skipped when Docker is not running. Everything this file creates carries the label
// mymind.test=<RUN> (containers) or is tracked by id (rows, dirs) and is removed in afterAll; it
// never touches a container without that label.
//
// What this proves on the dev Mac (Docker Desktop): exact flags on a live container, uid 10001,
// no app env/secrets/mounts, read-only rootfs, no caps, no IPv6, pids limit vs a fork bomb, the
// memory limit (reported as oom), RLIMIT_FSIZE, tainted = no network, PERSISTENT taint (kills the
// networked container + its background processes; later runs stay offline until re-enabled through
// the session-only API), symlinks resolve inside the container only, quota (bytes + files), idle
// stop, reconcile, one container under concurrency, timeout/abort (incl. an abort before the
// wrapper started)/output cap. LAN/host blocking needs the Linux firewall: proven in
// test/sandbox-firewall.db.test.ts (docker-in-docker) and in prod acceptance (Task 4).
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
import { execArgs, killExecArgs, parseExecStatus } from '@mymind/core/lib/sandbox/docker'

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
  const overQuota: Array<[string, { bytes: number; inodes: number }]> = []

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

  it('no IPv6 at all; RLIMIT_FSIZE stops any file at 1 GiB (sparse write past it fails)', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'cat /proc/sys/net/ipv6/conf/all/disable_ipv6; cat /proc/net/if_inet6 | grep -vc " lo$" || true; ulimit -f; dd if=/dev/zero of=/workspace/sparse bs=1 count=1 seek=1100M 2>&1; echo "dd=$?"; truncate -s 2G /workspace/t2 2>&1; echo "tr=$?"; dd if=/dev/zero of=/workspace/ok bs=1 count=1 seek=900M 2>/dev/null; echo "ok=$?"')
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe('1') // disable_ipv6 on every interface
    expect(lines[1]).toBe('0') // no IPv6 address except loopback
    expect(lines[2]).toBe(String(1024 ** 3 / 1024)) // bash: ulimit -f in 1 KiB blocks
    // 153 = 128 + SIGXFSZ: the kernel killed the writer at the limit.
    expect(r.stdout).toContain('dd=153')
    expect(r.stdout).toContain('tr=153')
    expect(r.stdout).toContain('ok=0')
  }, 120_000)

  it('the 2 GB memory limit kills a hog and is reported as oom, not a timeout', async () => {
    const id = await newWorkspace()
    const r = await m.exec(id, 'python3 -c "a = bytearray(3 * 1024**3); print(len(a))"', { timeoutSec: 60 })
    expect(r.exitCode).toBe(137)
    expect(r.oom).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.stderr).not.toContain('__mm_status__')
    // The container itself survived.
    expect((await m.exec(id, 'echo alive')).stdout.trim()).toBe('alive')
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

  it('taint is persistent: kills the networked container (background processes included); later untainted runs stay offline without secrets until Tony re-enables', async () => {
    const id = await newWorkspace()
    // An untainted background job: a heartbeat file, detached from the exec.
    await m.exec(id, 'setsid nohup sh -c "while true; do date +%s%N > /workspace/hb; sleep 0.2; done" >/dev/null 2>&1 &')
    await new Promise(res => setTimeout(res, 800))
    expect(inspect(id).State.Running).toBe(true)
    const first = await m.exec(id, 'cat /workspace/hb', { tainted: true })
    expect(first.tainted).toBe(true)
    // The networked container is stopped → the heartbeat is dead (its file stops changing).
    expect(inspect(id).State.Running).toBe(false)
    const a = (await m.exec(id, 'cat /workspace/hb', { tainted: true })).stdout
    await new Promise(res => setTimeout(res, 800))
    const b = (await m.exec(id, 'cat /workspace/hb', { tainted: true })).stdout
    expect(b).toBe(a)
    expect(await dbWorkspaceStore.get(id)).toMatchObject({ tainted: true, state: 'stopped' })
    // A later UNTAINTED call: still no route, no secret, and the networked container stays down.
    const later = await m.exec(id, 'echo "routes=$(awk \'NR>1\' /proc/net/route | wc -l) v=$MM_T1_SECRET"', { secrets: { MM_T1_SECRET: 'nope' } })
    expect(later.tainted).toBe(true)
    expect(later.stdout.trim()).toBe('routes=0 v=')
    expect(inspect(id).State.Running).toBe(false)
    // Tony re-enables (the session-only route → worker command → this; route: workspaces-api.test.ts).
    expect(await m.reenableNetwork(id)).toMatchObject({ id, tainted: false })
    const back = await m.exec(id, 'echo "routes=$(awk \'NR>1\' /proc/net/route | wc -l) v=$MM_T1_SECRET"', { secrets: { MM_T1_SECRET: 'yes' } })
    expect(back.tainted).toBe(false)
    expect(back.stdout.trim()).toMatch(/^routes=[1-9]\d* v=yes$/)
  }, 180_000)

  it('re-enable kills a tainted command still running BEFORE the flag clears: its late write never lands', async () => {
    const id = await newWorkspace()
    await m.exec(id, 'true', { tainted: true })
    const pending = m.exec(id, 'sleep 4; echo late > /workspace/late.txt', { tainted: true })
    await new Promise(res => setTimeout(res, 1500))
    expect(docker('ps', '-q', '--filter', `label=mymind.workspace=${id}`, '--filter', 'label=mymind.tainted=1').out.trim()).not.toBe('')
    const row = await m.reenableNetwork(id)
    expect(row.tainted).toBe(false)
    expect(docker('ps', '-aq', '--filter', `label=mymind.workspace=${id}`, '--filter', 'label=mymind.tainted=1').out.trim()).toBe('')
    const r = await pending
    expect(r.exitCode).not.toBe(0)
    await new Promise(res => setTimeout(res, 4000))
    expect((await m.exec(id, 'ls /workspace')).stdout).not.toContain('late.txt')
  }, 120_000)

  it('an abort while a fork bomb holds the pids limit ends it quickly (restart fallback), not at the 120s timeout', async () => {
    const id = await newWorkspace()
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 4000)
    const r = await m.exec(id, 'bomb() { bomb | bomb & }; bomb; sleep 300', { timeoutSec: 120, signal: ac.signal })
    expect(r.aborted).toBe(true)
    let pids = Number.POSITIVE_INFINITY
    for (let i = 0; i < 30 && pids > 50; i++) {
      await new Promise(res => setTimeout(res, 1000))
      const p = await m.exec(id, 'cat /sys/fs/cgroup/pids.current', { timeoutSec: 10 }).catch(() => null)
      if (p?.exitCode === 0) pids = Number(p.stdout.trim())
    }
    expect(pids).toBeLessThan(50)
    expect(Date.now() - t0).toBeLessThan(60_000)
  }, 180_000)

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
    expect(slow.oom).toBe(false)
    expect(Date.now() - t0).toBeLessThan(20_000)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const ab = await m.exec(id, 'sleep 120 & sleep 121', { signal: ac.signal })
    expect(ab.aborted).toBe(true)
    await new Promise(res => setTimeout(res, 1000))
    const ps = await m.exec(id, 'ps -eo args | grep -c "^sleep 12[01]" || true')
    expect(ps.stdout.trim()).toBe('0') // the whole group is gone, background child included
    // An abort that lands before the wrapper has even written its pid file (review M5): the kill
    // script runs FIRST (tombstone, no pid yet), then the wrapper starts — and must kill itself.
    const name = containerName(id)
    expect(docker(...killExecArgs(name, 'early-1')).code).toBe(0)
    const t1 = Date.now()
    const late = docker(...execArgs({ container: name, command: 'sleep 30', execId: 'early-1', timeoutSec: 60 }))
    expect(Date.now() - t1).toBeLessThan(10_000)
    expect(late.code).toBe(137)
    expect(parseExecStatus(late.err).status).toBe('aborted')
    expect((await m.exec(id, 'ps -eo args | grep -c "^sleep 30" || true')).stdout.trim()).toBe('0')
    const big = await m.exec(id, 'seq 1 100000; echo THE-END')
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(64 * 1024)
    expect(big.stdout.trim().endsWith('THE-END')).toBe(true)
  }, 120_000)

  it('quota: too many files → refused', async () => {
    const q = mk({ settings: { image: IMAGE, workspacesDir: root, firewall: 'off', dns: [], quotaInodes: 500 } })
    const id = await newWorkspace()
    await q.exec(id, 'mkdir many && cd many && seq 1 800 | xargs touch')
    await expect(q.checkQuota(id)).rejects.toThrow(/over its 500-file quota/)
    expect((await dbWorkspaceStore.get(id))!.inodesUsed).toBeGreaterThan(800)
    await q.exec(id, 'rm -rf many')
    await q.measure(id)
    await expect(q.checkQuota(id)).resolves.toBeUndefined()
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
    expect(overQuota.find(o => o[0] === id)![1].bytes).toBeGreaterThan(1024 * 1024)
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
