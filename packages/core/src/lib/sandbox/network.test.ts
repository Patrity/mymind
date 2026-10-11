// Cycle 82: the sandbox firewall plan (network.ts) and its provisioning twin
// (deploy/sandbox/install-network.sh) must never drift. The script is run for real against stub
// `iptables`/`docker` binaries that record every call; the rule set it would install is rebuilt
// from the log and checked with the same `checkIsolation` the worker uses at runtime.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BLOCKED_DESTINATIONS, FWD_CHAIN, IN_CHAIN, SANDBOX_BRIDGE, SANDBOX_NETWORK, SANDBOX_SUBNET,
  chainRules, checkIsolation, jumpRules, networkCreateArgs, ruleLine
} from './network'

const SCRIPT = path.resolve('deploy/sandbox/install-network.sh')

function planText(): string {
  // What `iptables -S` prints once the plan is installed (parents first, then our chains).
  return [
    '-P INPUT ACCEPT', '-N DOCKER-USER', `-N ${FWD_CHAIN}`, `-N ${IN_CHAIN}`,
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
    expect(a).not.toContain('--ipv6')
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
  it('fails for a network the rules do not cover', () => {
    expect(checkIsolation(planText(), { ...goodNet, bridgeName: undefined }).ok).toBe(false)
    expect(checkIsolation(planText(), { ...goodNet, icc: 'true' }).ok).toBe(false)
    expect(checkIsolation(planText(), { ...goodNet, ipv6: true }).ok).toBe(false)
    expect(checkIsolation(planText(), null).ok).toBe(false)
  })
})

describe('install-network.sh ↔ network.ts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-sbx-net-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.log')
  // Stub iptables: -C (exists?) says no, -N/-F/-A/-I/-D succeed; every call is logged.
  writeFileSync(path.join(dir, 'iptables'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = "-C" ] && exit 1\nexit 0\n`)
  // Stub docker: the network exists with the right options.
  writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "docker $*" >> "${log}"\ncase "$*" in\n  *bridge.name*) echo ${SANDBOX_BRIDGE};;\n  *enable_icc*) echo false;;\nesac\nexit 0\n`)
  chmodSync(path.join(dir, 'iptables'), 0o755)
  chmodSync(path.join(dir, 'docker'), 0o755)

  function runApply(): string[] {
    writeFileSync(log, '')
    execFileSync('bash', [SCRIPT, 'apply'], { env: { PATH: `${dir}:/usr/bin:/bin` }, stdio: 'pipe' })
    return readFileSync(log, 'utf8').split('\n').filter(Boolean)
  }

  /** Rebuild `iptables -S` from the -A / -I calls (only what this script adds; chains were flushed). */
  function rebuilt(calls: string[]): string {
    const chains = new Map<string, string[]>()
    for (const c of calls) {
      const p = c.split(' ')
      if (p[0] === '-A') { const ch = p[1]!; chains.set(ch, [...chains.get(ch) ?? [], `-A ${ch} ${p.slice(2).join(' ')}`]) }
      if (p[0] === '-I') { const ch = p[1]!; chains.set(ch, [`-A ${ch} ${p.slice(3).join(' ')}`, ...chains.get(ch) ?? []]) }
    }
    return [...chains.values()].flat().join('\n')
  }

  it('installs exactly the rules network.ts plans (no drift)', () => {
    const calls = runApply()
    expect(checkIsolation(rebuilt(calls), goodNet)).toEqual({ ok: true, problems: [] })
    // And nothing beyond the plan inside our chains.
    const ours = rebuilt(calls).split('\n').filter(l => l.startsWith(`-A ${FWD_CHAIN}`) || l.startsWith(`-A ${IN_CHAIN}`))
    expect(ours).toEqual(chainRules().map(ruleLine))
  })

  it('flushes only its own chains and inserts the jumps at position 1', () => {
    const calls = runApply()
    expect(calls.filter(c => c.startsWith('-F'))).toEqual([`-F ${FWD_CHAIN}`, `-F ${IN_CHAIN}`])
    expect(calls.filter(c => c.startsWith('-I'))).toEqual([
      `-I DOCKER-USER 1 -i ${SANDBOX_BRIDGE} -j ${FWD_CHAIN}`,
      `-I INPUT 1 -i ${SANDBOX_BRIDGE} -j ${IN_CHAIN}`
    ])
  })

  it('uses the same network shape as network.ts', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toContain(`NETWORK=${SANDBOX_NETWORK}`)
    expect(src).toContain(`BRIDGE=${SANDBOX_BRIDGE}`)
    expect(src).toContain(`SUBNET=${SANDBOX_SUBNET}`)
    expect(src).toContain(`BLOCKED="${BLOCKED_DESTINATIONS.join(' ')}"`)
  })
})
