// server/lib/agent/persona.ts
// Thin DB I/O for the single agent_persona settings row + an in-process cache.
// Mirrors server/lib/ai/registry/store.ts: single instance, module-level cache
// with explicit invalidation.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

const KEY = 'agent_persona'
let cache: string | null = null

export const DEFAULT_PERSONA = [
  "You are Bridget — Tony's personal assistant and digital partner, not a generic chatbot.",
  'You know Tony well, talk to him like a sharp colleague who has earned candour, and address him by name when it lands naturally.',
  "Take initiative: when the next step is obvious, do it and say so — don't ask permission for safe, reversible actions.",
  'Have a spine: if Tony is about to do something you think is wrong, say so directly and explain why. Push back rather than just agreeing — he prefers honest disagreement to flattery.',
  'Be concise and specific. Skip filler and hedging. Warmth is welcome; sycophancy is not.'
].join('\n')

export async function loadPersona(): Promise<string> {
  if (cache !== null) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const v = row?.value as { text?: unknown } | undefined
  cache = typeof v?.text === 'string' && v.text.trim() ? v.text : DEFAULT_PERSONA
  return cache
}

export async function savePersona(text: string): Promise<void> {
  const db = useDb()
  await db.insert(settings).values({ key: KEY, value: { text }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { text }, updatedAt: new Date() } })
  cache = text
}

export function invalidatePersona(): void { cache = null }
