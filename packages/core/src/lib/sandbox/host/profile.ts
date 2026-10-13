// Cycle 86 (spec §3, D6/D7): the macOS `sandbox-exec` profile a CONFINED workspace command runs
// under — a tainted run (switch on), or any command in an eval world. Pure: built from structure
// (never from caller text), so the eval spawn guard (spawn.ts) can check the structure and trust the
// profile it produces.
//
//   network*          denied (TCP/UDP, loopback and LAN included, and the unix socket DNS uses)
//   file-write*       denied everywhere except the workspace dir, the command's own tmp dir and the
//                     tty / null devices
//   appleevent-send   denied (osascript / JXA can't drive Messages, Mail or a browser)
//   mach-lookup       LaunchServices (`open https://…` hands a URL to the browser), the pasteboard,
//                     DNS-SD and nsurlsessiond (a background URL session runs out of process)
//   process-exec      /usr/bin/open and /usr/bin/osascript refused outright
//   file-read*        (eval worlds only) nothing under the user's home except the world's own dir
//
// Rule order matters: sandbox-exec applies the LAST matching rule, so every allow follows its deny.

export interface Confinement {
  /** Subpaths a confined command may write (absolute realpaths: /private/tmp, not /tmp). */
  writable: string[]
  /** Eval worlds: reads below this root are denied… */
  denyReadUnder?: string
  /** …except below these. */
  readable?: string[]
}

/** An SBPL string literal. Paths come from our own config, but a quote or a control character must
 *  never be able to end the literal and add a rule. */
export function sbplString(s: string): string {
  if (!s || /[\0-\x1f"\\]/.test(s)) throw new Error(`unsafe path for a sandbox profile: ${JSON.stringify(s)}`)
  return `"${s}"`
}

function absolute(p: string): string {
  if (!p.startsWith('/')) throw new Error(`a sandbox profile path must be absolute: ${p}`)
  return sbplString(p.replace(/\/+$/, '') || '/')
}

const DEVICES = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/tty")', '(regex #"^/dev/fd/")']

/** The profile text for `sandbox-exec -p`. */
export function confinementProfile(c: Confinement): string {
  if (!c.writable.length) throw new Error('a confined command needs a writable workspace dir')
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.dnssd.service") (global-name "com.apple.nsurlsessiond") (global-name-regex #"^com\\.apple\\.pasteboard\\."))',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
    '(deny file-write*)',
    `(allow file-write* ${[...c.writable.map(p => `(subpath ${absolute(p)})`), ...DEVICES].join(' ')})`
  ]
  if (c.denyReadUnder) {
    lines.push(`(deny file-read* (subpath ${absolute(c.denyReadUnder)}))`)
    if (c.readable?.length) lines.push(`(allow file-read* ${c.readable.map(p => `(subpath ${absolute(p)})`).join(' ')})`)
  }
  return lines.join('\n')
}

/** Where `sandbox-exec` lives (macOS only). */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
