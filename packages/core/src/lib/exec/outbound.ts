import { isPrivateAddress } from '../../utils/net'

/** Returns true when the `rm` invocation is a recursive+forced wipe of the filesystem root (`/` or `/*`). */
function isRootWipe(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  // Find `rm` (possibly preceded by `sudo` etc.)
  const rmIdx = tokens.findIndex(t => t === 'rm')
  if (rmIdx === -1) return false

  // Gather all tokens after `rm`
  const rest = tokens.slice(rmIdx + 1)

  // Collect single-char flags from every flag token; skip bare `--` (end-of-options sentinel)
  // Long options like --no-preserve-root don't grant -r/-f; only single-char flags count.
  let hasR = false
  let hasF = false
  const nonFlagArgs: string[] = []

  for (const tok of rest) {
    if (tok === '--') continue
    if (tok.startsWith('--')) {
      // long option — ignore (--no-preserve-root etc. don't add -r/-f)
      continue
    }
    if (tok.startsWith('-')) {
      for (const ch of tok.slice(1)) {
        if (ch === 'r' || ch === 'R') hasR = true
        if (ch === 'f') hasF = true
      }
    } else {
      nonFlagArgs.push(tok)
    }
  }

  if (!hasR || !hasF) return false

  // A root wipe hits `/` or `/*` as one of the target arguments.
  return nonFlagArgs.some(a => a === '/' || a === '/*')
}

const CATASTROPHIC: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,
]

export function isCatastrophic(command: string): boolean {
  return isRootWipe(command) || CATASTROPHIC.some(re => re.test(command))
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

/**
 * Extract all external (non-private) hosts from an outbound command string.
 * Returns the lowercased hostnames of every http(s):// URL in the command that
 * is NOT a private/loopback address. Port and IPv6 brackets are stripped.
 * Returns [] if the command is not an outbound tool or has no parseable URLs.
 * This is the canonical host-extraction helper; classifyOutbound calls it too.
 */
export function extractExternalHosts(command: string): string[] {
  if (!OUTBOUND_TOOLS.test(command)) return []
  const hosts = extractHosts(command)
  return hosts.filter(h => !(/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && isPrivateAddress(h))).map(h => h.toLowerCase())
}

/**
 * Extract the first external URL's scheme+host from an outbound command string,
 * returning `null` if the command is not outbound or carries no URL.
 * Exported so approvals.ts can build host-scoped patterns without duplicating URL parsing.
 * @deprecated Use extractExternalHosts for security-critical decisions.
 */
export function extractFirstExternalUrl(command: string): string | null {
  if (!OUTBOUND_TOOLS.test(command)) return null
  const urlRe = /\b(https?:\/\/[^/\s'"]+)/gi
  const m = urlRe.exec(command)
  if (!m) return null
  // Return scheme + host (strip :port so the pattern is host-only, not port-sensitive)
  const full = m[1]! // e.g. "https://api.github.com" or "https://api.github.com:443"
  // Strip port and trailing slash from host portion, keep scheme
  return full.replace(/:\d+$/, '')
}

export function classifyOutbound(command: string): 'none' | 'lan' | 'external' {
  const hosts = extractHosts(command)
  if (hosts.length === 0) return 'none'
  // A literal private IP is LAN; a public IP or ANY hostname is external (no DNS at gate).
  const allLan = hosts.every(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && isPrivateAddress(h))
  return allLan ? 'lan' : 'external'
}
