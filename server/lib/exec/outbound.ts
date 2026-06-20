import { isPrivateAddress } from '../../utils/net'

const CATASTROPHIC: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|\*|$)/i, // rm -rf / or /*
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(\s|\*|$)/i,
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,
]

export function isCatastrophic(command: string): boolean {
  return CATASTROPHIC.some(re => re.test(command))
}

// Extract URLs and host:port args from outbound-capable commands. We only classify
// commands that actually reach the network (curl/wget); everything else is 'none'.
const OUTBOUND_TOOLS = /\b(curl|wget)\b/

function extractHosts(command: string): string[] {
  if (!OUTBOUND_TOOLS.test(command)) return []
  const hosts: string[] = []
  const urlRe = /\bhttps?:\/\/([^/\s'"]+)/gi
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(command))) {
    const hostport = m[1]!
    hosts.push(hostport.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')) // strip :port and [ipv6]
  }
  return hosts
}

export function classifyOutbound(command: string): 'none' | 'lan' | 'external' {
  const hosts = extractHosts(command)
  if (hosts.length === 0) return 'none'
  // A literal private IP is LAN; a public IP or ANY hostname is external (no DNS at gate).
  const allLan = hosts.every(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && isPrivateAddress(h))
  return allLan ? 'lan' : 'external'
}
