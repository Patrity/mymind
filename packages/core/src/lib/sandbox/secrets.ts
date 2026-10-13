// Cycle 82 Task 3 (spec §6): which exec secrets reach a sandbox command, and keeping their VALUES
// out of everything that leaves the sandbox (tool results, watch notes, the Files/Shells UI).
//
//   Injection: only secrets Tony opted in (Settings → Secrets → Sandbox), and NEVER when the run or
//   the workspace is tainted (a tainted command runs in a one-off `--network none` container; the
//   manager drops secrets there too — this is the first of the two gates). Names the docker CLI or
//   the sandbox's base env own (DOCKER_*, HOME, PATH, LANG, …: docker.ts assertSecretName) are
//   stripped, never passed — they would steer the CLI or clobber the sandbox env. A value shorter
//   than MIN_SANDBOX_SECRET_CHARS is never injected (the toggle refuses it too: it can't be masked
//   without mangling ordinary output).
//   Masking (fix round 1, M1/M2): every INJECTABLE value is masked whatever its length; other exec
//   secrets from 6 chars (the host exec rule). Longest first, so a value containing another is
//   replaced whole. Output that was CUT (a tail, a window, a cap) is masked before the cut, or the
//   cut edge is trimmed of anything that could be the visible half of a secret (maskCut).
import { currentEvalScope } from '../eval/context'
import { getDecryptedSecrets, getSandboxOptedSecrets } from '../exec/secrets'
import { assertSecretName } from './docker'

export const REDACTED = '«redacted»'
/** Shorter opted-in values are neither injected nor accepted by the toggle. */
export const MIN_SANDBOX_SECRET_CHARS = 4
/** Non-injected exec secrets are masked from this length (the host `exec` tool's rule). */
const MIN_OTHER_MASK_CHARS = 6

export function isSandboxSecretName(name: string): boolean {
  try { assertSecretName(name); return true } catch { return false }
}

/** The env a sandbox command gets on top of HOME/PATH/LANG: opted-in secrets, unless tainted. */
export async function sandboxSecretEnv(o: { tainted: boolean }): Promise<Record<string, string>> {
  // Cycle 85: an eval sandbox never gets a secret (its manager also refuses any).
  if (o.tainted || currentEvalScope()) return {}
  let opted: Record<string, string>
  try { opted = await getSandboxOptedSecrets() } catch (err) { throw new SecretStoreUnavailableError(err) }
  return Object.fromEntries(Object.entries(opted).filter(([k, v]) => isSandboxSecretName(k) && v.length >= MIN_SANDBOX_SECRET_CHARS))
}

/** The values to mask: injectable ones at any length, the rest from 6 chars; longest first, unique. */
export function maskList(all: Record<string, string>, opted: Record<string, string>): string[] {
  const set = new Set<string>()
  for (const v of Object.values(opted)) if (v) set.add(v)
  for (const v of Object.values(all)) if (v && v.length >= MIN_OTHER_MASK_CHARS) set.add(v)
  return [...set].sort((a, b) => b.length - a.length)
}

/** The secret store could not be read, so nothing that might hold a value can be shown. Tool
 *  handlers turn it into the "output withheld" result (tools/workspace.ts guard). */
export class SecretStoreUnavailableError extends Error {
  override name = 'SecretStoreUnavailableError'
  constructor(cause?: unknown) { super(`the secret store could not be read${cause instanceof Error ? ` (${cause.message})` : ''}, so secret values could not be masked`) }
}

/** The current mask list. Throws SecretStoreUnavailableError when the store is unreadable — every
 *  caller fails closed on it. */
export async function secretValues(): Promise<string[]> {
  try {
    const [all, opted] = await Promise.all([getDecryptedSecrets(), getSandboxOptedSecrets()])
    return maskList(all, opted)
  } catch (err) {
    throw new SecretStoreUnavailableError(err)
  }
}

/** Replace every whole occurrence of each value (longest first). */
export function maskText(text: string, values: string[]): string {
  let out = text
  for (const v of values) if (v && out.includes(v)) out = out.split(v).join(REDACTED)
  return out
}

/** Length of the longest proper suffix of a value that `text` starts with (0 = none). */
function leadingPartial(text: string, values: string[]): number {
  let k = 0
  for (const v of values) for (let n = Math.min(v.length - 1, text.length); n > k; n--) if (text.startsWith(v.slice(-n))) { k = n; break }
  return k
}

/** Length of the longest proper prefix of a value that `text` ends with (0 = none). */
export function trailingPartial(text: string, values: string[]): number {
  let k = 0
  for (const v of values) for (let n = Math.min(v.length - 1, text.length); n > k; n--) if (text.endsWith(v.slice(0, n))) { k = n; break }
  return k
}

/**
 * Mask a piece of output that may have been CUT: `start` = something before it was dropped (a
 * tail), `end` = something after it was dropped (a head / a window that more may follow). Whole
 * values are masked first; then the cut edge loses whatever could be the visible part of a value
 * straddling it (a proper suffix of a value at the start, a proper prefix at the end).
 */
export function maskCut(text: string, values: string[], cut: { start?: boolean; end?: boolean }): string {
  let out = maskText(text, values)
  if (cut.start) out = out.slice(leadingPartial(out, values))
  if (cut.end) out = out.slice(0, out.length - trailingPartial(out, values))
  return out
}

/** Replace secret values in every string inside `v` (objects/arrays walked; keys left alone). */
export function maskDeep<T>(v: T, values: string[]): T {
  if (!values.length) return v
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return maskText(x, values)
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
