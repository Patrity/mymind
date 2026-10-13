// Cycle 86 (spec §3, D6/D7): the macOS `sandbox-exec` profile a CONFINED workspace command runs
// under — a tainted run (switch on), or any command in an eval world. Pure: built from structure
// (never from caller text), so the eval spawn guard (spawn.ts) can check the structure and trust the
// profile it produces.
//
//   network*          denied (TCP/UDP, loopback and LAN included, AF_UNIX sockets, the socket DNS uses)
//   file-write*       denied everywhere except the workspace dir, the command's own tmp dir and the
//                     tty / null devices
//   user-preference-write  denied (fix round 1: `defaults write` goes through cfprefsd, out of
//                     process — it would otherwise persist a plist under ~/Library/Preferences)
//   appleevent-send   denied (osascript / JXA can't drive Messages, Mail or a browser)
//   mach-lookup       out-of-process services that would act for the command: LaunchServices
//                     (`open https://…` hands a URL to the browser), the pasteboard, DNS-SD,
//                     nsurlsessiond (background URL sessions), securityd (the keychain — `git
//                     credential-osxkeychain get` / `gh auth token` read it out of process), imagent /
//                     IMCore (Messages), sharingd (AirDrop) and Shortcuts / WorkflowKit
//   process-exec      /usr/bin/open, /usr/bin/osascript and /usr/bin/shortcuts refused outright
//   file-read*        Bridget's credentials (fix round 1, C1: ~/.ssh, ~/.config/gh, ~/.netrc, ~/.aws,
//                     the keychains, browser profiles, Messages / Mail, MyMind's own env files, …)
//                     — and, in eval worlds, nothing under the user's home except the world's own dir
//
// Rule order matters: sandbox-exec applies the LAST matching rule, so every allow follows its deny,
// and the credential read-denies come last of all (nothing re-allows them).
//
// Known limit (accepted, fix round 1): a HARD LINK already in the workspace (planted by an earlier
// clean run, or by `git clone` of a local repo, which hard-links objects) is written through to the
// file it shares an inode with — the write rule is path-based. A confined command cannot CREATE one
// (`ln` gets EPERM), and the per-command tmp dir is always fresh. The mach-lookup list is a deny-list
// of known proxies, not an allow-list (backlog: measure what bash/git/python/curl need and invert it).

export interface Confinement {
  /** Subpaths a confined command may write (absolute realpaths: /private/tmp, not /tmp). */
  writable: string[]
  /** Eval worlds: reads below this root are denied… */
  denyReadUnder?: string
  /** …except below these. */
  readable?: string[]
  /** Paths that can never be read (credentials, MyMind's env) — denied last, whatever else allows. */
  secretPaths?: string[]
  /** Path prefixes under which any name containing token / credential / secret is unreadable. */
  secretNameUnder?: string[]
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

/** An SBPL regex literal matching `prefix` literally, then `tail` (our own regex text). */
function regexUnder(prefix: string, tail: string): string {
  absolute(prefix) // same validation as a path literal
  const esc = prefix.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]]/g, m => `\\${m}`)
  return `#"^${esc}${tail}"`
}

/**
 * Fix round 1 (C1): what a confined command may never read in Bridget's home — her logins and
 * secrets (a tainted run must not be able to read them into its output), plus MyMind's own env
 * files (`extra`: the worker's .env / .env.native and ~/mymind/env).
 */
export function credentialPaths(home: string, extra: string[] = []): string[] {
  const h = home.replace(/\/+$/, '')
  const appSupport = `${h}/Library/Application Support`
  return [
    `${h}/.ssh`, `${h}/.config/gh`, `${h}/.netrc`, `${h}/.aws`, `${h}/.docker`, `${h}/.kube`, `${h}/.gnupg`,
    `${h}/.git-credentials`, `${h}/.config/git/credentials`, `${h}/.npmrc`, `${h}/.pypirc`, `${h}/.config/op`,
    `${h}/Library/Keychains`, `${h}/Library/Cookies`, `${h}/Library/Safari`, `${h}/Library/Containers/com.apple.Safari`,
    `${appSupport}/Google/Chrome`, `${appSupport}/BraveSoftware`, `${appSupport}/Microsoft Edge`, `${appSupport}/Firefox`, `${appSupport}/Arc`,
    `${h}/Library/Messages`, `${h}/Library/Mail`,
    `${h}/mymind/env`, `${h}/mymind/app/.env`, `${h}/mymind/app/.env.native`,
    ...extra
  ]
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
  const secrets = [
    ...(c.secretPaths ?? []).map(p => `(subpath ${absolute(p)})`),
    ...(c.secretNameUnder ?? []).map(p => `(regex ${regexUnder(p, '/.*([Tt]oken|[Cc]redential|[Ss]ecret)')})`)
  ]
  if (secrets.length) lines.push(`(deny file-read* ${secrets.join(' ')})`)
  return lines.join('\n')
}

/** The out-of-process services a confined command may not reach (see the header). */
export const MACH_DENY: readonly string[] = [
  '(global-name "com.apple.coreservices.launchservicesd")',
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
