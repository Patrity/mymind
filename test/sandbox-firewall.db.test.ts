// Cycle 82 Task 1 — the sandbox egress firewall on a REAL Linux netfilter, in docker-in-docker.
// The dev Mac has no iptables (Docker Desktop's VM is not reachable as a host), so this file starts a
// privileged `docker:dind` container (label mymind.test=<RUN>, removed in afterAll) that plays the
// LXC: its own dockerd, a "Postgres" bound to its loopback, a service on its LAN IP, and a LAN peer
// (a sibling container on the outer Docker network). It then runs deploy/sandbox/install-network.sh
// exactly as provisioning would and probes from a container on the mymind-sandbox network:
//   before the rules: the LAN peer + host services ARE reachable (the probes are meaningful);
//   after:  LAN peer, host LAN IP, sandbox gateway, host loopback service → all refused;
//           a public IP (1.1.1.1:443 / :53 over TCP) → reachable;
//   and the worker's fail-closed check (verifyNetworkIsolation) is red before and green after,
//   reading the REAL `iptables -S`; red again when FORWARD stops reaching DOCKER-USER or when it
//   reads the other iptables backend (review I3);
//   re-applying the rules under a continuous probe never lets a single packet through (review M2).
// Skipped when Docker is down, privileged containers are not allowed, or images can't be pulled.
// Prod acceptance (Task 4) repeats the probes in LXC 114 against the real Postgres and LAN.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyNetworkIsolation, type DockerRunner } from '@mymind/core/lib/sandbox/docker'
import { SANDBOX_BRIDGE } from '@mymind/core/lib/sandbox/network'

const RUN = `sbxfw-${process.pid}-${Date.now().toString(36)}`
const DIND = `mm-dind-${RUN}`
const PEER = `mm-lanpeer-${RUN}`

function sh(cmd: string, args: string[], input?: Buffer): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, input, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const docker = (...a: string[]) => sh('docker', a)
const inDind = (cmd: string) => sh('docker', ['exec', DIND, 'sh', '-c', cmd])
const dockerUp = docker('version', '--format', '{{.Server.Version}}').code === 0

describe.skipIf(!dockerUp)('sandbox firewall (docker-in-docker, real iptables)', () => {
  let ready = false
  let peerIp = ''
  let dindIp = ''
  const probeTargets = () => [`${peerIp}:9000`, `${dindIp}:8088`, '172.31.82.1:8088', '172.31.82.1:5432', '1.1.1.1:443', '1.1.1.1:53']

  /** Probe each target from a container on the sandbox network: "<target> OPEN|BLOCKED".
   *  Up to 3 tries each (final fix wave — the parallel-run flake): the listeners are single-shot
   *  `nc -l` in a respawn loop, and `<dind>:8088` and `172.31.82.1:8088` hit the SAME listener back
   *  to back, so the second connect can land in the respawn gap (measured: 7 of 80 back-to-back
   *  connects refused on an idle machine; more under a parallel test:db run). A retry can only turn
   *  a refusal into OPEN — a REJECTed target fails every try, so BLOCKED stays meaningful. */
  function probe(): Record<string, 'OPEN' | 'BLOCKED'> {
    const loop = probeTargets().map(t => `ok=0; for k in 1 2 3; do if timeout 4 nc -w 3 ${t.split(':')[0]} ${t.split(':')[1]} </dev/null >/dev/null 2>&1; then ok=1; break; fi; sleep 0.3; done; if [ $ok = 1 ]; then echo "${t} OPEN"; else echo "${t} BLOCKED"; fi`).join('; ')
    const r = inDind(`docker run --rm --network mymind-sandbox alpine:3.20 sh -c '${loop}'`)
    expect(r.code, r.err).toBe(0)
    return Object.fromEntries(r.out.trim().split('\n').map(l => l.split(' ') as [string, 'OPEN' | 'BLOCKED']))
  }
  const dindRunner: DockerRunner = async (args) => {
    const r = sh('docker', ['exec', DIND, 'docker', ...args])
    return { code: r.code, stdout: r.out, stderr: r.err, timedOut: false, aborted: false, truncated: false }
  }
  const iptablesS = async () => {
    const r = inDind('iptables -S')
    if (r.code !== 0) throw new Error(r.err)
    return r.out
  }

  beforeAll(async () => {
    for (const img of ['docker:28-dind', 'alpine:3.20']) {
      if (docker('image', 'inspect', img).code !== 0 && docker('pull', '-q', img).code !== 0) return
    }
    const dir = path.resolve('deploy/sandbox')
    if (docker('run', '-d', '--privileged', '--name', DIND, '--label', `mymind.test=${RUN}`, '-v', `${dir}:/sbx:ro`, 'docker:28-dind').code !== 0) return
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      up = inDind('docker version >/dev/null 2>&1').code === 0
      if (!up) await new Promise(r => setTimeout(r, 1000))
    }
    if (!up) return
    if (inDind('command -v bash >/dev/null || apk add -q bash').code !== 0) return
    const save = spawnSync('docker', ['save', 'alpine:3.20'], { maxBuffer: 256 * 1024 * 1024 })
    if (sh('docker', ['exec', '-i', DIND, 'docker', 'load', '-q'], save.stdout).code !== 0) return
    // The LAN peer: a sibling on the outer network (the homelab LAN, as seen from the LXC).
    if (docker('run', '-d', '--name', PEER, '--label', `mymind.test=${RUN}`, 'alpine:3.20', 'sh', '-c', 'while true; do echo peer | nc -l -p 9000; done').code !== 0) return
    peerIp = docker('inspect', '-f', '{{.NetworkSettings.IPAddress}}', PEER).out.trim()
    dindIp = docker('inspect', '-f', '{{.NetworkSettings.IPAddress}}', DIND).out.trim()
    // "Postgres" on the host loopback, a service on all host addresses.
    sh('docker', ['exec', '-d', DIND, 'sh', '-c', 'while true; do echo pg | nc -l -s 127.0.0.1 -p 5432; done'])
    sh('docker', ['exec', '-d', DIND, 'sh', '-c', 'while true; do echo svc | nc -l -p 8088; done'])
    // The network exactly as the script creates it, but no rules yet (control run).
    ready = inDind('docker network create --driver bridge --subnet 172.31.82.0/24 --opt com.docker.network.bridge.name=br-mymind-sbx --opt com.docker.network.bridge.enable_icc=false mymind-sandbox').code === 0
  }, 600_000)

  afterAll(() => {
    const ids = docker('ps', '-aq', '--filter', `label=mymind.test=${RUN}`).out.split('\n').filter(Boolean)
    if (ids.length) docker('rm', '-f', '-v', ...ids)
  }, 120_000)

  it('without the rules the LAN and the host are reachable (the probe is meaningful); the worker refuses', async (ctx) => {
    if (!ready) ctx.skip()
    const p = probe()
    expect(p[`${peerIp}:9000`]).toBe('OPEN')
    expect(p[`${dindIp}:8088`]).toBe('OPEN')
    expect(p['172.31.82.1:8088']).toBe('OPEN')
    const check = await verifyNetworkIsolation(dindRunner, iptablesS)
    expect(check.ok).toBe(false)
    expect(check.problems.join()).toContain('missing iptables rule')
  }, 120_000)

  it('install-network.sh apply (twice) blocks LAN, host and gateway; the internet stays reachable', async (ctx) => {
    if (!ready) ctx.skip()
    for (let i = 0; i < 2; i++) {
      const r = inDind('bash /sbx/install-network.sh apply')
      expect(r.code, r.err).toBe(0)
    }
    const rules = await iptablesS()
    // Idempotent: exactly one jump each, at the top of its parent chain.
    expect(rules.split('\n').filter(l => l === `-A DOCKER-USER -i ${SANDBOX_BRIDGE} -j MYMIND-SANDBOX-FWD`)).toHaveLength(1)
    expect(rules.split('\n').filter(l => l === `-A INPUT -i ${SANDBOX_BRIDGE} -j MYMIND-SANDBOX-IN`)).toHaveLength(1)
    const p = probe()
    expect(p).toEqual({
      [`${peerIp}:9000`]: 'BLOCKED', // RFC1918 LAN peer (forward path, DOCKER-USER)
      [`${dindIp}:8088`]: 'BLOCKED', // the host's own LAN IP (input path)
      '172.31.82.1:8088': 'BLOCKED', // the sandbox gateway = the host
      '172.31.82.1:5432': 'BLOCKED', // "Postgres" on the host loopback, via the gateway
      '1.1.1.1:443': 'OPEN', // internet
      '1.1.1.1:53': 'OPEN' // public DNS (TCP; Docker Desktop drops outbound UDP)
    })
  }, 180_000)

  it('the worker\'s fail-closed check passes on the real rules', async (ctx) => {
    if (!ready) ctx.skip()
    expect(await verifyNetworkIsolation(dindRunner, iptablesS)).toEqual({ ok: true, problems: [] })
    // …and goes red again the moment a rule disappears.
    inDind('iptables -D MYMIND-SANDBOX-FWD -d 192.168.0.0/16 -j REJECT --reject-with icmp-net-prohibited')
    const check = await verifyNetworkIsolation(dindRunner, iptablesS)
    expect(check.ok).toBe(false)
    expect(check.problems.join()).toContain('192.168.0.0/16')
    inDind('bash /sbx/install-network.sh apply')
    expect((await verifyNetworkIsolation(dindRunner, iptablesS)).ok).toBe(true)
  }, 120_000)

  it('red when FORWARD no longer reaches DOCKER-USER, or when the check reads the other iptables backend (review I3)', async (ctx) => {
    if (!ready) ctx.skip()
    inDind('iptables -D FORWARD -j DOCKER-USER')
    try {
      const check = await verifyNetworkIsolation(dindRunner, iptablesS)
      expect(check.ok).toBe(false)
      expect(check.problems.join()).toContain('DOCKER-USER is never reached')
      // …and the provisioning script refuses rather than "fixing" an unreachable chain.
      const r = inDind('bash /sbx/install-network.sh apply')
      expect(r.code).not.toBe(0)
      expect(r.out + r.err).toContain('FORWARD does not jump to DOCKER-USER')
    } finally { inDind('iptables -I FORWARD 1 -j DOCKER-USER') }
    expect((await verifyNetworkIsolation(dindRunner, iptablesS)).ok).toBe(true)
    // dockerd here writes through iptables-nft; reading iptables-legacy sees none of its chains.
    const legacy = async () => inDind('iptables-legacy -S').out
    const mismatch = await verifyNetworkIsolation(dindRunner, legacy)
    expect(mismatch.ok).toBe(false)
    expect(mismatch.problems.join()).toContain('backend mismatch')
  }, 120_000)

  it('re-applying the rules never opens a window (continuous probe during 15 re-applies, review M2)', async (ctx) => {
    if (!ready) ctx.skip()
    // A sandbox hammers the LAN peer and the host for the whole duration; every success is logged.
    // 6 parallel probers (busybox nc waits out its -w on a reject, so one loop is too sparse).
    const one = `end=$(( $(date +%s) + 25 )); n=0; while [ $(date +%s) -lt $end ]; do n=$((n+1)); nc -w 1 ${peerIp} 9000 </dev/null >/dev/null 2>&1 && echo LEAK-peer; nc -w 1 172.31.82.1 8088 </dev/null >/dev/null 2>&1 && echo LEAK-host; done; echo "tries=$n"`
    const loop = `for k in 1 2 3 4 5 6; do ( ${one} ) & done; wait`
    const name = `mm-probe-${RUN}`
    expect(inDind(`docker run -d --name ${name} --network mymind-sandbox alpine:3.20 sh -c '${loop}'`).code).toBe(0)
    await new Promise(r => setTimeout(r, 1500))
    for (let i = 0; i < 15; i++) expect(inDind('bash /sbx/install-network.sh apply').code).toBe(0)
    let out = ''
    for (let i = 0; i < 40 && (out.match(/tries=/g) ?? []).length < 6; i++) {
      await new Promise(r => setTimeout(r, 1000))
      out = inDind(`docker logs ${name}`).out
    }
    inDind(`docker rm -f ${name}`)
    const tries = [...out.matchAll(/tries=(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
    expect(tries).toBeGreaterThan(50) // > 100 connection attempts across the 15 swaps
    expect(out).not.toContain('LEAK')
  }, 180_000)
})
