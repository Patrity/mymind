import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret, decryptSecret } from '../ai/registry/crypto'

const KEY = 'exec_secrets'
// stored shape: { version: 1, secrets: Record<name, encryptedBase64>, sandbox?: name[] }
// `sandbox` (cycle 82, spec §6): the names Tony opted in to the workspace sandbox — default off. It
// lives in the same settings doc as the secrets (no table of its own), so an absent list = none.
type Doc = { version: 1; secrets: Record<string, string>; sandbox?: string[] }
let cache: Doc | null = null

export function isValidSecretName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) // valid env var name; shell-safe
}
export function lastFour(value: string): string {
  return value.slice(-4)
}

async function load(): Promise<Doc> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = (row?.value as Doc) ?? { version: 1, secrets: {} }
  return cache
}
/** Forget the cached doc (cycle 81: the web's secret PUT/DELETE tell the worker via `invalidate`). */
export function invalidateExecSecrets(): void { cache = null }

async function save(doc: Doc): Promise<void> {
  await useDb().insert(settings).values({ key: KEY, value: doc, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: doc, updatedAt: new Date() } })
  cache = doc
}

export async function listSecretNames(): Promise<{ name: string; lastFour: string; sandbox: boolean }[]> {
  const doc = await load()
  const sb = new Set(doc.sandbox ?? [])
  return Object.entries(doc.secrets).map(([name, enc]) => ({ name, lastFour: lastFour(decryptSecret(enc)), sandbox: sb.has(name) }))
}
export async function setSecret(name: string, value: string): Promise<void> {
  if (!isValidSecretName(name)) throw new Error('invalid secret name (must be UPPER_SNAKE env var name)')
  const doc = await load()
  // Replacing a value keeps its sandbox opt-in.
  await save({ version: 1, secrets: { ...doc.secrets, [name]: encryptSecret(value) }, sandbox: doc.sandbox ?? [] })
}
export async function deleteSecret(name: string): Promise<void> {
  const doc = await load()
  const { [name]: _drop, ...rest } = doc.secrets
  // A deleted secret's opt-in goes with it (re-created later under the same name, it starts off).
  await save({ version: 1, secrets: rest, sandbox: (doc.sandbox ?? []).filter(n => n !== name) })
}
export class UnknownSecretError extends Error { override name = 'UnknownSecretError' }
/** Opt a secret in to (or out of) the workspace sandbox (cycle 82, spec §6). */
export async function setSecretSandbox(name: string, sandbox: boolean): Promise<void> {
  const doc = await load()
  if (!(name in doc.secrets)) throw new UnknownSecretError(`no secret named ${name}`)
  const rest = (doc.sandbox ?? []).filter(n => n !== name)
  await save({ version: 1, secrets: doc.secrets, sandbox: sandbox ? [...rest, name] : rest })
}
/** The secrets opted in to the sandbox, decrypted (lib/sandbox/secrets.ts filters and gates them). */
export async function getSandboxOptedSecrets(): Promise<Record<string, string>> {
  const doc = await load()
  const out: Record<string, string> = {}
  for (const name of doc.sandbox ?? []) {
    const enc = doc.secrets[name]
    if (enc) out[name] = decryptSecret(enc)
  }
  return out
}
export async function getDecryptedSecrets(): Promise<Record<string, string>> {
  const doc = await load()
  const out: Record<string, string> = {}
  for (const [name, enc] of Object.entries(doc.secrets)) out[name] = decryptSecret(enc)
  return out
}
