// Cycle 82 Task 3 (spec §6): which exec secrets reach a sandbox command, and keeping their VALUES
// out of everything that leaves the sandbox (tool results, the Files/Shells UI).
//
//   Injection: only secrets Tony opted in (Settings → Secrets → Sandbox), and NEVER when the run or
//   the workspace is tainted (a tainted command runs in a one-off `--network none` container; the
//   manager drops secrets there too — this is the first of the two gates). Names the docker CLI or
//   the sandbox's base env own (DOCKER_*, HOME, PATH, LANG, …: docker.ts assertSecretName) are
//   stripped, never passed — they would steer the CLI or clobber the sandbox env.
//   Masking: every exec secret's value is replaced with «redacted» in workspace tool results and UI
//   reads (the same rule as the host `exec` tool). Names may appear; values never.
import { getDecryptedSecrets, getSandboxOptedSecrets } from '../exec/secrets'
import { maskSecrets } from '../observability/redact'
import { assertSecretName } from './docker'

export function isSandboxSecretName(name: string): boolean {
  try { assertSecretName(name); return true } catch { return false }
}

/** The env a sandbox command gets on top of HOME/PATH/LANG: opted-in secrets, unless tainted. */
export async function sandboxSecretEnv(o: { tainted: boolean }): Promise<Record<string, string>> {
  if (o.tainted) return {}
  const opted = await getSandboxOptedSecrets()
  return Object.fromEntries(Object.entries(opted).filter(([k]) => isSandboxSecretName(k)))
}

/** Every exec secret value (masking covers all of them, opted in or not). */
export async function secretValues(): Promise<string[]> {
  return Object.values(await getDecryptedSecrets())
}

/** Replace secret values in every string inside `v` (objects/arrays walked; keys left alone). */
export function maskDeep<T>(v: T, values: string[]): T {
  if (!values.some(x => x && x.length >= 6)) return v
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return maskSecrets(x, values)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, walk(y)]))
    }
    return x
  }
  return walk(v) as T
}

/** maskDeep with the current secret values (fails closed: unreadable store → throws). */
export async function maskSecretValues<T>(v: T): Promise<T> {
  return maskDeep(v, await secretValues())
}
