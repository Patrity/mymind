// Cycle 82: the sandbox firewall plan (network.ts) and its provisioning twin
// (deploy/sandbox/install-network.sh) must never drift. The script runs for real against a
// simulated filter table (test/fixtures/iptables-sim.py, which also snapshots the table after every
// mutation) and a stub `docker`; the result — and every intermediate state — is checked with the
// same `checkIsolation` the worker uses at runtime.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BLOCKED_DESTINATIONS, DOCKER_CHAIN, DOCKER_FORWARD_JUMP, FWD_CHAIN, IN_CHAIN, SANDBOX_BRIDGE, SANDBOX_NETWORK, SANDBOX_SUBNET,
  chainRules, checkIsolation, jumpRules, networkCreateArgs, ruleLine
} from './network'

const SCRIPT = path.resolve('deploy/sandbox/install-network.sh')

function planText(): string {
  // What `iptables -S` prints once the plan is installed (parents first, then our chains).
  return [
    '-P INPUT ACCEPT', '-P FORWARD ACCEPT', DOCKER_CHAIN, '-N DOCKER-USER', `-N ${FWD_CHAIN}`, `-N ${IN_CHAIN}`,
    DOCKER_FORWARD_JUMP, '-A FORWARD -j DOCKER-FORWARD',
    ...jumpRules().map(ruleLine), ...chainRules().map(ruleLine)
  ].join('\n')
}
const goodNet = { bridgeName: SANDBOX_BRIDGE, icc: 'false', subnet: SANDBOX_SUBNET, ipv6: false }

describe('network plan', () => {
  it('blocks every private / link-local / CGNAT / loopback / reserved range and nothing public', () => {
    expect(BLOCKED_DESTINATIONS).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8']))
    const fwd = chainRules().filter(r => r.chain === FWD_CHAIN)
    expect(fwd.at(-1)!.args).toEqual(['-j', 'RETURN'])
    expect(fwd.slice(0, -1).every(r => r.args[0] === '-d' && r.args.includes('REJECT'))).toBe(true)
    // The sandbox's own subnet (and so its gateway = the host) is inside a blocked range.
    expect(SANDBOX_SUBNET.startsWith('172.31.')).toBe(true)
  })

  it('rejects every new connection from the bridge to the host itself', () => {
    const inp = chainRules().filter(r => r.chain === IN_CHAIN).map(r => r.args.join(' '))
    expect(inp).toEqual(['-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT', '-j REJECT --reject-with icmp-host-prohibited'])
    expect(jumpRules().map(ruleLine)).toEqual([
      `-A DOCKER-USER -i ${SANDBOX_BRIDGE} -j ${FWD_CHAIN}`,
      `-A INPUT -i ${SANDBOX_BRIDGE} -j ${IN_CHAIN}`
    ])
  })

  it('creates the network with the fixed bridge name, no icc', () => {
    const a = networkCreateArgs()
    expect(a).toContain(`com.docker.network.bridge.name=${SANDBOX_BRIDGE}`)
    expect(a).toContain('com.docker.network.bridge.enable_icc=false')
    expect(a).toContain('--ipv6=false')
    expect(a.at(-1)).toBe(SANDBOX_NETWORK)
  })
})

describe('checkIsolation', () => {
  it('passes the exact plan', () => {
    expect(checkIsolation(planText(), goodNet)).toEqual({ ok: true, problems: [] })
  })
  it('fails when a block rule is missing', () => {
    const t = planText().split('\n').filter(l => !l.includes('192.168.0.0/16')).join('\n')
    const c = checkIsolation(t, goodNet)
    expect(c.ok).toBe(false)
    expect(c.problems.join()).toContain('192.168.0.0/16')
  })
  it('fails when the INPUT jump is missing (host reachable)', () => {
    const t = planText().split('\n').filter(l => !l.startsWith('-A INPUT')).join('\n')
    expect(checkIsolation(t, goodNet).ok).toBe(false)
  })
  it('fails when an ACCEPT precedes the jump', () => {
    const t = planText().replace(`-A DOCKER-USER -i ${SANDBOX_BRIDGE}`, `-A DOCKER-USER -j ACCEPT\n-A DOCKER-USER -i ${SANDBOX_BRIDGE}`)
    expect(checkIsolation(t, goodNet).problems.join()).toContain('not the first rule of DOCKER-USER')
  })
  it('fails when the chain order differs (RETURN before a block)', () => {
    const lines = planText().split('\n')
    const ret = lines.findIndex(l => l === `-A ${FWD_CHAIN} -j RETURN`)
    const [r] = lines.splice(ret, 1)
    lines.splice(lines.findIndex(l => l.startsWith(`-A ${FWD_CHAIN}`)), 0, r!)
    expect(checkIsolation(lines.join('\n'), goodNet).ok).toBe(false)
  })
  it('fails when FORWARD never reaches DOCKER-USER (orphaned chain) or it is not first', () => {
    const gone = checkIsolation(planText().replace(`${DOCKER_FORWARD_JUMP}\n`, ''), goodNet)
    expect(gone.problems.join()).toContain('DOCKER-USER is never reached')
    const late = checkIsolation(planText().replace(`${DOCKER_FORWARD_JUMP}\n-A FORWARD -j DOCKER-FORWARD`, `-A FORWARD -j DOCKER-FORWARD\n${DOCKER_FORWARD_JUMP}`), goodNet)
    expect(late.problems.join()).toContain('not the first rule of FORWARD')
  })
  it('fails when dockerd\'s chains are invisible (iptables backend mismatch) or docker uses nftables', () => {
    expect(checkIsolation(planText().replace(`${DOCKER_CHAIN}\n`, ''), goodNet).problems.join()).toContain('backend mismatch')
    expect(checkIsolation(planText(), { ...goodNet, firewallDriver: 'nftables' }).ok).toBe(false)
    expect(checkIsolation(planText(), { ...goodNet, firewallDriver: 'iptables' }).ok).toBe(true)
    expect(checkIsolation(planText(), { ...goodNet, firewallDriver: 'iptables+firewalld' }).ok).toBe(true)
  })
  it('fails for a network the rules do not cover', () => {
    expect(checkIsolation(planText(), { ...goodNet, bridgeName: undefined }).ok).toBe(false)
    expect(checkIsolation(planText(), { ...goodNet, icc: 'true' }).ok).toBe(false)
    expect(checkIsolation(planText(), { ...goodNet, ipv6: true }).ok).toBe(false)
    expect(checkIsolation(planText(), null).ok).toBe(false)
  })
})

describe('install-network.sh ↔ network.ts (simulated filter table)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-sbx-net-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const state = path.join(dir, 'state.json')
  const snaps = path.join(dir, 'snaps.txt')
  copyFileSync(path.resolve('test/fixtures/iptables-sim.py'), path.join(dir, 'iptables'))
  copyFileSync(path.resolve('test/fixtures/iptables-sim.py'), path.join(dir, 'iptables-restore'))
  chmodSync(path.join(dir, 'iptables'), 0o755)
  chmodSync(path.join(dir, 'iptables-restore'), 0o755)
  // Stub docker: the network exists with the right options.
  writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\ncase "$*" in\n  *bridge.name*) echo ${SANDBOX_BRIDGE};;\n  *enable_icc*) echo false;;\nesac\nexit 0\n`)
  chmodSync(path.join(dir, 'docker'), 0o755)

  /** What dockerd leaves behind on start (+ one foreign rule each in INPUT and DOCKER-USER). */
  function dockerdState(o: { forwardJump?: boolean; dockerChain?: boolean } = {}) {
    const chains: Record<string, string[]> = {
      INPUT: ['-i lo -j ACCEPT'],
      FORWARD: [...(o.forwardJump === false ? [] : ['-j DOCKER-USER']), '-j DOCKER-FORWARD'],
      OUTPUT: [],
      'DOCKER-USER': ['-s 10.9.9.9/32 -j DROP'],
      'DOCKER-FORWARD': []
    }
    if (o.dockerChain !== false) chains.DOCKER = []
    writeFileSync(state, JSON.stringify({ order: Object.keys(chains), chains }))
    writeFileSync(snaps, '')
  }
  function apply() {
    writeFileSync(snaps, '')
    return spawnSync('bash', [SCRIPT, 'apply'], { env: { PATH: `${dir}:/usr/bin:/bin`, IPT_STATE: state, IPT_SNAPSHOTS: snaps }, encoding: 'utf8' })
  }
  const table = () => spawnSync(path.join(dir, 'iptables'), ['-S'], { env: { IPT_STATE: state, IPT_SNAPSHOTS: '/dev/null' }, encoding: 'utf8' }).stdout
  const snapshots = () => readFileSync(snaps, 'utf8').split('=====\n').map(x => x.trim()).filter(Boolean)

  it('installs exactly the rules network.ts plans, keeps foreign rules', () => {
    dockerdState()
    const r = apply()
    expect(r.status, r.stderr).toBe(0)
    const t = table()
    expect(checkIsolation(t, goodNet)).toEqual({ ok: true, problems: [] })
    const ours = t.split('\n').filter(l => l.startsWith(`-A ${FWD_CHAIN}`) || l.startsWith(`-A ${IN_CHAIN}`))
    expect(ours).toEqual(chainRules().map(ruleLine))
    expect(t).toContain('-A INPUT -i lo -j ACCEPT')
    expect(t).toContain('-A DOCKER-USER -s 10.9.9.9/32 -j DROP')
  })

  it('re-applying never leaves an unfiltered moment (every intermediate table passes the check)', () => {
    dockerdState()
    expect(apply().status).toBe(0)
    for (let i = 0; i < 2; i++) {
      expect(apply().status).toBe(0)
      const s = snapshots()
      expect(s.length).toBeGreaterThan(0)
      for (const snap of s) expect(checkIsolation(snap, goodNet)).toEqual({ ok: true, problems: [] })
    }
  }, 60_000) // ~60 python iptables-sim spawns: well over 5s on a loaded machine (full parallel run)

  it('repairs a jump that slipped below another rule or got duplicated, without a gap', () => {
    dockerdState()
    expect(apply().status).toBe(0)
    // Someone inserted an ACCEPT above our jump and appended a duplicate.
    const st = JSON.parse(readFileSync(state, 'utf8')) as { chains: Record<string, string[]> }
    st.chains['DOCKER-USER'] = ['-j ACCEPT', ...st.chains['DOCKER-USER']!, `-i ${SANDBOX_BRIDGE} -j ${FWD_CHAIN}`]
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), chains: st.chains }))
    expect(checkIsolation(table(), goodNet).ok).toBe(false)
    expect(apply().status).toBe(0)
    expect(checkIsolation(table(), goodNet)).toEqual({ ok: true, problems: [] })
    // From the moment the jump was back on top, it never left.
    const s = snapshots()
    const firstOk = s.findIndex(x => checkIsolation(x, goodNet).ok)
    expect(firstOk).toBeGreaterThanOrEqual(0)
    for (const snap of s.slice(firstOk)) expect(checkIsolation(snap, goodNet).ok).toBe(true)
  // Two script runs (each spawns a shell): past vitest's 5 s default under a loaded machine (cycle 83).
  }, 30_000)

  it('refuses (non-zero, nothing installed) when FORWARD does not reach DOCKER-USER', () => {
    dockerdState({ forwardJump: false })
    const r = apply()
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('FORWARD does not jump to DOCKER-USER')
    expect(table()).not.toContain(FWD_CHAIN)
  })

  it('refuses when dockerd\'s chains are not visible (backend mismatch)', () => {
    dockerdState({ dockerChain: false })
    const r = apply()
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('backend mismatch')
  })

  it('uses the same network shape as network.ts', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toContain(`NETWORK=${SANDBOX_NETWORK}`)
    expect(src).toContain(`BRIDGE=${SANDBOX_BRIDGE}`)
    expect(src).toContain(`SUBNET=${SANDBOX_SUBNET}`)
    expect(src).toContain(`BLOCKED="${BLOCKED_DESTINATIONS.join(' ')}"`)
    expect(src).toContain('--ipv6=false')
  })
})

describe('provision-native.sh §3b (rereview #6): sandbox setup never fails the deploy', () => {
  const src = readFileSync(path.resolve('deploy/provision-native.sh'), 'utf8')
  const block = src.slice(src.indexOf('SANDBOX_MIN_BUILD_GB='), src.indexOf('# 4. systemd units'))
  /** `prevImage`: what `docker image inspect mymind-sandbox:current` answers (a stub on PATH). */
  function runBlock(installExit: number, buildExit: number, o: { prevImage?: string; freeGb?: number } = {}) {
    const app = mkdtempSync(path.join(tmpdir(), 'mm-prov-'))
    try {
      const sbx = path.join(app, 'deploy/sandbox')
      const bin = path.join(app, 'bin')
      spawnSync('mkdir', ['-p', sbx, bin])
      writeFileSync(path.join(sbx, 'install-network.sh'), `echo "[sandbox-net] ERROR: stub"; exit ${installExit}\n`)
      writeFileSync(path.join(sbx, 'build-image.sh'), `echo built; exit ${buildExit}\n`)
      writeFileSync(path.join(bin, 'docker'), o.prevImage ? `#!/bin/sh\necho ${o.prevImage}\n` : '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      writeFileSync(path.join(bin, 'df'), `#!/bin/sh\necho "Filesystem 1G-blocks Used Available Use% Mounted"; echo "/dev/x 100G 10G ${o.freeGb ?? 50}G 10% /"\n`, { mode: 0o755 })
      const script = `set -euo pipefail\nAPP_DIR=${JSON.stringify(app)}\n${block}\necho REACHED-UNITS\n`
      return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    } finally { rmSync(app, { recursive: true, force: true }) }
  }
  it('a failing install-network.sh warns (a ::warning:: on the deploy run) and provisioning carries on', () => {
    const r = runBlock(1, 0)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('::warning title=Sandbox::install-network.sh failed')
    expect(r.stdout).toContain('REACHED-UNITS')
    expect(r.stdout).not.toContain('built')
  })
  it('final review M7: a failed REBUILD names the previous image still in use; with none it says there is no image', () => {
    const rebuild = runBlock(0, 1, { prevImage: 'sha256:0123456789abcdef0123' })
    expect(rebuild.status).toBe(0)
    expect(rebuild.stdout).toMatch(/::warning title=Sandbox::the sandbox image build failed — rebuild failed, previous image 0123456789ab still active/)
    expect(rebuild.stdout).toContain('REACHED-UNITS')
    const none = runBlock(0, 1)
    expect(none.stdout).toMatch(/::warning title=Sandbox::the sandbox image build failed — no sandbox image: workspace tools stay DISABLED/)
  })
  it('final review I6: the build needs >= 6 GB free (the watchdog stops sandboxes under 4 and resumes at 5)', () => {
    const low = runBlock(0, 0, { freeGb: 5 })
    expect(low.stdout).toMatch(/only 5 GB free on \/ \(the build needs >= 6 GB/)
    expect(low.stdout).not.toContain('built')
    const ok = runBlock(0, 0, { freeGb: 6 })
    expect(ok.stdout).toContain('built')
    expect(ok.stdout).not.toContain('::warning')
  })
})

describe('install-network.sh install (final review M6)', () => {
  it('the boot oneshot runs a copy outside the CD-managed tree', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toMatch(/^LIB_COPY="\$LIB_DIR\/install-network\.sh"$/m)
    expect(src).toMatch(/^LIB_DIR=\/usr\/local\/lib\/mymind$/m)
    expect(src).toMatch(/install -D -m 0755 "\$SELF" "\$LIB_COPY"/)
    expect(src).toContain('ExecStart=/bin/bash $LIB_COPY apply')
    expect(src).not.toContain('ExecStart=/bin/bash $SELF')
  })
})

describe('deploy.yml sandbox health step (follow-up N7)', () => {
  it('has its own 2-minute timeout and never fails the deploy', () => {
    const y = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8')
    const step = y.slice(y.indexOf('- name: Sandbox health'))
    expect(step).toMatch(/continue-on-error: true/)
    expect(step).toMatch(/^\s+timeout-minutes: 2$/m)
  })
})
