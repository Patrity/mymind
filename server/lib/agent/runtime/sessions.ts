// Session key → conversation. `main` is Bridget's one home thread (created lazily, at most one
// by index); `thread:new` starts a side thread; `thread:<id>` continues one; `isolated:<slug>`
// is a fresh thread for a noisy background errand.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'
import { createConversation, deriveTitle } from '../../../services/conversations'
import type { SessionKey } from './types'

// A `thread:<id>` key can arrive from untrusted external input (a client WS frame — Task 9).
// Validate the shape BEFORE querying: an id that was never a UUID at all (not merely one that
// doesn't exist) must fail the same clean way as an unknown-but-valid one, not surface a raw
// Postgres driver error (invalid input syntax for type uuid) up through the caller.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getOrCreateMain(): Promise<string> {
  const db = useDb()
  const [existing] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.kind, 'main')).limit(1)
  if (existing) return existing.id
  // Two callers can race here; the loser hits conversations_one_main and re-reads.
  const [row] = await db.insert(conversations).values({ title: 'Bridget', kind: 'main' })
    .onConflictDoNothing().returning({ id: conversations.id })
  if (row) return row.id
  const [again] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.kind, 'main')).limit(1)
  return again!.id
}

export async function resolveSession(key: SessionKey | 'thread:new', opts: { titleHint?: string } = {}): Promise<{ conversationId: string; created: boolean }> {
  if (key === 'main') return { conversationId: await getOrCreateMain(), created: false }
  if (key === 'thread:new') {
    const c = await createConversation({ title: deriveTitle(opts.titleHint ?? '') })
    return { conversationId: c.id, created: true }
  }
  if (key.startsWith('isolated:')) {
    const c = await createConversation({ title: `wake: ${key.slice('isolated:'.length)}` })
    return { conversationId: c.id, created: true }
  }
  const id = key.slice('thread:'.length)
  if (!UUID_RE.test(id)) throw new Error(`conversation ${id} not found`)
  const [row] = await useDb().select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).limit(1)
  if (!row) throw new Error(`conversation ${id} not found`)
  return { conversationId: row.id, created: false }
}
