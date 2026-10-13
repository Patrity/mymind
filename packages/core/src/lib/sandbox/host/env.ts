// Cycle 86 (spec §3): the environment a workspace command runs with on the host — Bridget's login
// environment (HOME, her Homebrew PATH, so her CLI logins under ~ just work), NOT the worker's own:
// the worker's env holds MyMind's database URL and API keys, and none of it reaches a command.
// Opted-in secrets (Settings → Secrets → "export to Bridget's shell") are added on top for clean
// runs only — never for a tainted run, an eval world or one of MyMind's own fixed scripts.
import os from 'node:os'

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Names a secret may never take: they would steer the shell, the dynamic loader, an interpreter or
 *  the command's own base env. */
const SECRET_DENY = /^(DOCKER_.*|BUILDKIT_.*|COMPOSE_.*|LD_.*|DYLD_.*|GCONV_PATH|NLSPATH|LOCPATH|MALLOC_.*|GODEBUG|GOGC|GOMAXPROCS|GOMEMLIMIT|GOTRACEBACK|GORACE|SSL_CERT_.*|SSLKEYLOGFILE|(HTTPS?|FTP|ALL|NO)_PROXY|TMPDIR|TMP|TEMP|XDG_.*|HOME|PATH|LANG|LANGUAGE|LC_.*|HOSTNAME|TERM|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|BASH_FUNC_.*|PS4|NOTARY_.*|SSH_AUTH_SOCK|NODE_OPTIONS|PYTHON(PATH|STARTUP|HOME)|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG.*|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|SHELLOPTS|BASHOPTS)$/i

/** Throws unless `name` is a safe secret name for a workspace command's env. */
export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name) || SECRET_DENY.test(name)) throw new Error(`invalid sandbox secret name ${name} (reserved or not an identifier)`)
}

/** PATH when the worker's env doesn't name one (`WORKSPACE_PATH`): Homebrew first (Apple Silicon,
 *  then Intel), then the system. */
export function defaultWorkspacePath(home: string): string {
  return [`${home}/.local/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
}

/** The base env of a clean command: who Bridget is, where her tools are. */
export function hostBaseEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = from.HOME || os.homedir()
  const user = from.USER || from.LOGNAME || safeUser()
  const env: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: from.SHELL || '/bin/bash',
    PATH: from.WORKSPACE_PATH || defaultWorkspacePath(home),
    LANG: from.LANG || 'en_US.UTF-8',
    TERM: 'dumb'
  }
  // Her ssh agent (git over ssh) — clean commands only (confinedEnv drops it).
  if (from.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = from.SSH_AUTH_SOCK
  return env
}

function safeUser(): string {
  try { return os.userInfo().username } catch { return 'bridget' }
}

/** A confined command's env: the base env minus the ssh agent, its own TMPDIR. */
export function confinedEnv(base: Record<string, string>, tmpDir: string): Record<string, string> {
  const { SSH_AUTH_SOCK: _agent, ...rest } = base
  return { ...rest, TMPDIR: tmpDir }
}

/** Keys an eval world's command may carry — nothing else (no secrets, no agent socket). */
export const EVAL_ENV_KEYS: ReadonlySet<string> = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'TMPDIR'])
