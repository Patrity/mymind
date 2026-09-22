// test/conversation-leaf.db.test.ts
//
// setActiveLeaf has two properties the route depends on, neither of which the mocked route
// test (test/conversation-leaf-route.test.ts) can reach: (1) it must SCOPE to the given
// conversation — a message id from elsewhere must be refused, writing nothing — and (2) it must
// resolve the chosen message to its branch TIP before writing, not the message itself. Both are
// proven against the real DB, the same harness as test/conversation-branch.db.test.ts.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { appendMessages, setActiveLeaf, getConversation } = await import('../server/services/conversations')

// drizzle-orm/node-postgres's db.execute() returns a pg `Result`, not a plain array — unwrap
// `.rows` (same correction as test/conversation-path.db.test.ts).
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows

const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string
// Every conversation this file creates, so afterAll cleans up even if a test throws midway.
const created: string[] = []

async function newConversation(suffix: string): Promise<string> {
  const [conv] = rows<{ id: string }>(await useDb().execute(
    sql`insert into conversations (title) values (${'zz-leaf-' + TAG + suffix}) returning id`
  ))
  created.push(conv!.id)
  return conv!.id
}

async function activeLeafOf(id: string): Promise<string | null> {
  const [conv] = rows<{ active_leaf_id: string | null }>(await useDb().execute(
    sql`select active_leaf_id from conversations where id = ${id}::uuid`
  ))
  return conv!.active_leaf_id
}

beforeAll(async () => {
  convId = await newConversation('')
})
afterAll(async () => {
  const db = useDb()
  for (const id of created) {
    await db.execute(sql`delete from conversation_messages where conversation_id = ${id}::uuid`)
    await db.execute(sql`delete from conversations where id = ${id}::uuid`)
  }
})

const msg = (role: 'user' | 'assistant', content: string) => ({
  role, content, modality: 'text' as const, toolCalls: null, reasoning: null, attachments: null, usage: null
})

describe('setActiveLeaf resolves to the branch tip, not the requested message', () => {
  it('sets up a fork with an unequal continuation on one side', async () => {
    // Q1 -> A1 (leaf so far)
    await appendMessages(convId, [msg('user', 'Q1'), msg('assistant', 'A1')])
    const q1 = (await getConversation(convId))!.messages.find(m => m.content === 'Q1')!

    // A second answer to Q1 — a sibling of A1, and the new leaf.
    await appendMessages(convId, [msg('assistant', 'A1-alt')], q1.id)
    // A1-alt gets its OWN continuation, chained from the current leaf (A1-alt).
    await appendMessages(convId, [msg('user', 'Q2')])

    const all = (await getConversation(convId))!.messages
    expect(all.map(m => m.content)).toEqual(['Q1', 'A1-alt', 'Q2'])   // sanity: active path today
  })

  it('control: switching to a leaf with no children resolves to itself', async () => {
    // A1 is off the active path here but has no children of its own.
    const a1 = (rows<{ content: string, id: string }>(await useDb().execute(
      sql`select id, content from conversation_messages where conversation_id = ${convId}::uuid and content = 'A1'`
    )))[0]!
    const resolved = await setActiveLeaf(convId, a1.id)
    expect(resolved).toBe(a1.id)
    expect(await activeLeafOf(convId)).toBe(a1.id)
  })

  it('switching to a sibling that has its OWN continuation lands on that branch\'s tip, not the sibling', async () => {
    const rowset = rows<{ id: string, content: string }>(await useDb().execute(
      sql`select id, content from conversation_messages where conversation_id = ${convId}::uuid`
    ))
    const a1alt = rowset.find(r => r.content === 'A1-alt')!
    const q2 = rowset.find(r => r.content === 'Q2')!

    // The prior test left the leaf on A1 (no children). Switching to A1-alt must NOT stop at
    // A1-alt — it has a child (Q2) — so the resolved leaf, and the DB row, must be Q2's id.
    const resolved = await setActiveLeaf(convId, a1alt.id)
    expect(resolved).toBe(q2.id)
    expect(resolved).not.toBe(a1alt.id)
    expect(await activeLeafOf(convId)).toBe(q2.id)

    // And the read path agrees: the active transcript now ends at Q2 via A1-alt, not at A1-alt.
    const path = (await getConversation(convId))!.messages
    expect(path.map(m => m.content)).toEqual(['Q1', 'A1-alt', 'Q2'])
  })
})

describe('setActiveLeaf scoping', () => {
  it('refuses a message id that belongs to a DIFFERENT conversation, and writes nothing', async () => {
    const other = await newConversation('-other')
    await appendMessages(other, [msg('user', 'elsewhere-Q'), msg('assistant', 'elsewhere-A')])
    const theirs = (await getConversation(other))!.messages
    const target = theirs.find(m => m.content === 'elsewhere-A')!

    // Positive control: the id is real and resolvable from its OWN conversation.
    expect(await setActiveLeaf(other, target.id)).toBe(target.id)

    const before = await activeLeafOf(convId)
    const resolved = await setActiveLeaf(convId, target.id)
    expect(resolved).toBeNull()
    // Nothing was written to convId's row — the guard REFUSES, it does not merely lie about it.
    expect(await activeLeafOf(convId)).toBe(before)
  })

  it('returns null for an id that exists nowhere, and writes nothing', async () => {
    const before = await activeLeafOf(convId)
    const resolved = await setActiveLeaf(convId, '00000000-0000-4000-8000-000000000000')
    expect(resolved).toBeNull()
    expect(await activeLeafOf(convId)).toBe(before)
  })
})
