// Cycle 82 (spec §2, D5): the sandbox network and its egress firewall — as DATA.
//
// The sandbox network is a user-defined bridge with a FIXED interface name, so iptables rules can
// key on it before (and regardless of when) Docker creates it:
//   * forward path (sandbox → LAN / other containers / anything routed): our chain
//     MYMIND-SANDBOX-FWD, jumped from DOCKER-USER for packets entering from the bridge. Rejects every
//     private, link-local, CGNAT, loopback, multicast and reserved destination; the rest (the
//     internet) RETURNs to Docker's own chains (NAT/masquerade as usual).
//   * input path (sandbox → THIS host: the docker gateway IP, the LXC's own LAN IP, any published
//     port incl. Postgres/SearXNG): DOCKER-USER never sees these (they are not forwarded), so a
//     second chain MYMIND-SANDBOX-IN is jumped from INPUT for the bridge and rejects all new
//     connections. Replies to host-initiated traffic stay allowed (there is none today).
// DNS: the containers use Docker's embedded resolver, which forwards from the container's own
// network namespace — a LAN resolver (the router) would be rejected — so sandboxes get public
// resolvers explicitly (SANDBOX_DNS).
//
// Single source of truth: deploy/sandbox/install-network.sh carries the same rules (it runs at
// provisioning time, before any Node build exists); network.test.ts (next to this file) fails on
// drift, and test/sandbox-firewall.db.test.ts proves the rules on real netfilter (docker-in-docker).
//
// Reachability (review I3): our DOCKER-USER rules only matter if dockerd's FORWARD chain jumps to
// DOCKER-USER in the SAME iptables backend we inspect. The check therefore also requires dockerd's
// own `-A FORWARD -j DOCKER-USER` (first in FORWARD) and its `-N DOCKER` chain to be visible — a
// legacy/nft mismatch, `"iptables": false` or Docker's nftables backend all make them vanish — and
// `docker info`'s firewall backend to be iptables.
// The worker verifies the live rules with `verifyNetworkIsolation` before it starts a sandbox on a
// Linux host (fail closed): a network without its firewall never runs agent code.

export const SANDBOX_NETWORK = 'mymind-sandbox'
export const SANDBOX_BRIDGE = 'br-mymind-sbx'
export const SANDBOX_SUBNET = '172.31.82.0/24'
export const FWD_CHAIN = 'MYMIND-SANDBOX-FWD'
export const IN_CHAIN = 'MYMIND-SANDBOX-IN'
export const DEFAULT_SANDBOX_DNS = ['1.1.1.1', '9.9.9.9'] as const

/** Destinations a sandbox may never reach (IPv4). The network has no IPv6. */
export const BLOCKED_DESTINATIONS = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // CGNAT (RFC6598) — also Tailscale
  '127.0.0.0/8', // loopback (route_localnet tricks)
  '169.254.0.0/16', // link-local (cloud metadata)
  '172.16.0.0/12', // RFC1918 — includes the docker bridges and the sandbox's own gateway
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // RFC1918 — the homelab LAN
  '198.18.0.0/15', // benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4' // reserved + broadcast
] as const

/** `docker network create` argv (without the leading `docker`). */
export function networkCreateArgs(): string[] {
  return [
    'network', 'create',
    '--driver', 'bridge',
    '--subnet', SANDBOX_SUBNET,
    '--opt', `com.docker.network.bridge.name=${SANDBOX_BRIDGE}`,
    // Sandboxes can't talk to each other (icc) — and the FWD chain rejects the subnet anyway.
    '--opt', 'com.docker.network.bridge.enable_icc=false',
    '--ipv6=false', // the rules are IPv4-only; containers also get disable_ipv6 (docker.ts)
    '--label', 'mymind.sandbox=network',
    SANDBOX_NETWORK
  ]
}

export interface IptablesRule {
  /** The chain the rule is appended to. */
  chain: string
  /** iptables args after `-A <chain>`. */
  args: string[]
}

/** The rules inside our two chains, in order (each chain is flushed then refilled). */
export function chainRules(): IptablesRule[] {
  const fwd: IptablesRule[] = BLOCKED_DESTINATIONS.map(d => ({ chain: FWD_CHAIN, args: ['-d', d, '-j', 'REJECT', '--reject-with', 'icmp-net-prohibited'] }))
  fwd.push({ chain: FWD_CHAIN, args: ['-j', 'RETURN'] })
  const inp: IptablesRule[] = [
    { chain: IN_CHAIN, args: ['-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'] },
    { chain: IN_CHAIN, args: ['-j', 'REJECT', '--reject-with', 'icmp-host-prohibited'] }
  ]
  return [...fwd, ...inp]
}

/** The jumps into our chains (inserted at position 1 of the parent chain, idempotently). */
export function jumpRules(): IptablesRule[] {
  return [
    { chain: 'DOCKER-USER', args: ['-i', SANDBOX_BRIDGE, '-j', FWD_CHAIN] },
    { chain: 'INPUT', args: ['-i', SANDBOX_BRIDGE, '-j', IN_CHAIN] }
  ]
}

/** `iptables -S` line for a rule — what `iptables -S <chain>` prints for it. */
export function ruleLine(r: IptablesRule): string {
  return ['-A', r.chain, ...r.args].join(' ')
}

/** Normalise whitespace of an `iptables -S` line. The plan is written in iptables' own canonical
 *  `-S` form (e.g. `--ctstate RELATED,ESTABLISHED`), checked against real iptables in the dind test. */
function norm(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

export interface IsolationCheck {
  ok: boolean
  problems: string[]
}

/**
 * Check `iptables -S` output (all chains) and `docker network inspect` facts against the plan.
 * Pure: the caller runs the commands (docker.ts verifyNetworkIsolation).
 */
/** dockerd's own rules that prove our iptables sees the backend dockerd writes to. */
export const DOCKER_FORWARD_JUMP = '-A FORWARD -j DOCKER-USER'
export const DOCKER_CHAIN = '-N DOCKER'

export interface NetworkFacts {
  bridgeName?: string
  icc?: string
  subnet?: string
  ipv6?: boolean
  /** `docker info` .FirewallBackend.Driver (Docker ≥ 28); undefined when the daemon doesn't say. */
  firewallDriver?: string
}

export function checkIsolation(iptablesS: string, net: NetworkFacts | null): IsolationCheck {
  const lines = iptablesS.split('\n').map(norm).filter(Boolean)
  const have = new Set(lines)
  const problems: string[] = []
  if (!have.has(DOCKER_CHAIN)) problems.push('dockerd\'s DOCKER chain is not visible to this iptables — backend mismatch (legacy vs nft) or docker runs with iptables disabled')
  const firstForward = lines.find(l => l.startsWith('-A FORWARD '))
  if (!have.has(DOCKER_FORWARD_JUMP)) problems.push(`missing ${DOCKER_FORWARD_JUMP} — DOCKER-USER is never reached`)
  else if (firstForward !== DOCKER_FORWARD_JUMP) problems.push(`${DOCKER_FORWARD_JUMP} is not the first rule of FORWARD`)
  if (net?.firewallDriver !== undefined && !net.firewallDriver.startsWith('iptables')) problems.push(`docker's firewall backend is ${net.firewallDriver}, not iptables — these rules would not apply`)
  for (const r of [...jumpRules(), ...chainRules()]) {
    if (!have.has(ruleLine(r))) problems.push(`missing iptables rule: ${ruleLine(r)}`)
  }
  // The jumps must come FIRST in their parent chains — an earlier ACCEPT would bypass them.
  for (const j of jumpRules()) {
    const first = lines.find(l => l.startsWith(`-A ${j.chain} `))
    if (have.has(ruleLine(j)) && first !== ruleLine(j)) problems.push(`jump into ${j.args.at(-1)} is not the first rule of ${j.chain}`)
  }
  // Order matters inside our chains: the RETURN / REJECT terminal rules must be last.
  for (const chain of [FWD_CHAIN, IN_CHAIN]) {
    const want = chainRules().filter(r => r.chain === chain).map(ruleLine)
    const got = lines.filter(l => l.startsWith(`-A ${chain} `))
    if (got.join('\n') !== want.join('\n')) problems.push(`chain ${chain} differs from the plan (order or extra rules)`)
  }
  if (!net) problems.push(`docker network ${SANDBOX_NETWORK} does not exist`)
  else {
    if (net.bridgeName !== SANDBOX_BRIDGE) problems.push(`network ${SANDBOX_NETWORK} bridge is ${net.bridgeName ?? '(default)'}, not ${SANDBOX_BRIDGE} — the firewall would not apply`)
    if (net.icc !== 'false') problems.push(`network ${SANDBOX_NETWORK} allows inter-container traffic`)
    if (net.ipv6) problems.push(`network ${SANDBOX_NETWORK} has IPv6 enabled (rules are IPv4-only)`)
  }
  return { ok: problems.length === 0, problems }
}
