import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret, decryptSecret } from '../ai/registry/crypto'

const KEY = 'exec_secrets'
// stored shape: { version: 1, secrets: Record<name, encryptedBase64> }
type Doc = { version: 1; secrets: Record<string, string> }
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
async function save(doc: Doc): Promise<void> {
  await useDb().insert(settings).values({ key: KEY, value: doc, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: doc, updatedAt: new Date() } })
  cache = doc
}

export async function listSecretNames(): Promise<{ name: string; lastFour: string }[]> {
  const doc = await load()
  return Object.entries(doc.secrets).map(([name, enc]) => ({ name, lastFour: lastFour(decryptSecret(enc)) }))
}
export async function setSecret(name: string, value: string): Promise<void> {
  if (!isValidSecretName(name)) throw new Error('invalid secret name (must be UPPER_SNAKE env var name)')
  const doc = await load()
  await save({ version: 1, secrets: { ...doc.secrets, [name]: encryptSecret(value) } })
}
export async function deleteSecret(name: string): Promise<void> {
  const doc = await load()
  const { [name]: _drop, ...rest } = doc.secrets
  await save({ version: 1, secrets: rest })
}
export async function getDecryptedSecrets(): Promise<Record<string, string>> {
  const doc = await load()
  const out: Record<string, string> = {}
  for (const [name, enc] of Object.entries(doc.secrets)) out[name] = decryptSecret(enc)
  return out
}
