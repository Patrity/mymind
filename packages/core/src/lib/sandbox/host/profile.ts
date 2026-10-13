// Cycle 86 (spec §3, D7): the macOS `sandbox-exec` profile every command in an EVAL WORLD runs under
// (harness isolation — Tony dropped confinement for agent runs, 2026-10-13, option C). Pure: built
// from structure (never from caller text), so the eval spawn guard (spawn.ts) can check the structure
// and trust the profile it produces. Every path must be a realpath — an SBPL rule naming a path
// through a symlink matches nothing (the manager resolves them).
//
//   network*          denied (TCP/UDP, loopback and LAN included, AF_UNIX sockets, the socket DNS uses)
//   file-write*       denied everywhere except the world's workspace dir, the command's own tmp dir
//                     and the tty / null devices
//   file-read*        nothing under the user's home except the world's own dir
//   user-preference-write  denied (`defaults write` goes through cfprefsd, out of process)
//   appleevent-send   denied (osascript / JXA can't drive Messages, Mail or a browser)
//   mach-lookup       out-of-process services that would act for the command: all of CoreServices
//                     and lsd (LaunchServices — `LSOpenCFURLRef("http://…")` would hand a URL, and
//                     whatever data it carries, to the browser; re-review fix round 1, I4: denying
//                     launchservicesd alone is not enough), the pasteboard, DNS-SD, nsurlsessiond,
//                     securityd (the keychain), imagent / IMCore (Messages), sharingd (AirDrop) and
//                     Shortcuts / WorkflowKit
//   process-exec      /usr/bin/open, /usr/bin/osascript and /usr/bin/shortcuts refused outright
//
// Rule order matters: sandbox-exec applies the LAST matching rule, so every allow follows its deny.
//
// Known limit (accepted): a HARD LINK already in the world's dir is written through to the file it
// shares an inode with — the write rule is path-based. A confined command cannot CREATE one (`ln`
// gets EPERM). The mach-lookup list is a deny-list of known proxies, not an allow-list (backlog).

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
    '(deny user-preference-write)',
    '(deny appleevent-send)',
    `(deny mach-lookup ${MACH_DENY.join(' ')})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/shortcuts"))',
    '(deny file-write*)',
    `(allow file-write* ${[...c.writable.map(p => `(subpath ${absolute(p)})`), ...DEVICES].join(' ')})`
  ]
  if (c.denyReadUnder) {
    lines.push(`(deny file-read* (subpath ${absolute(c.denyReadUnder)}))`)
    if (c.readable?.length) lines.push(`(allow file-read* ${c.readable.map(p => `(subpath ${absolute(p)})`).join(' ')})`)
  }
  return lines.join('\n')
}

/** The out-of-process services a confined command may not reach (see the header). */
export const MACH_DENY: readonly string[] = [
  '(global-name-regex #"^com\\.apple\\.coreservices\\.")',
  '(global-name-regex #"^com\\.apple\\.lsd\\.")',
  '(global-name "com.apple.dnssd.service")',
  '(global-name "com.apple.nsurlsessiond")',
  '(global-name-regex #"^com\\.apple\\.pasteboard\\.")',
  '(global-name "com.apple.SecurityServer")',
  '(global-name "com.apple.securityd.xpc")',
  '(global-name-regex #"^com\\.apple\\.(imagent|imcore|IMCore|imtransfer)")',
  '(global-name-regex #"^com\\.apple\\.sharingd")',
  '(global-name-regex #"^com\\.apple\\.(shortcuts|siriactions|WorkflowKit)")'
]

/** Where `sandbox-exec` lives (macOS only). */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
