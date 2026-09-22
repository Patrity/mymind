// test/conversation-path.db.test.ts
//
// A thread is a tree. `getAgentHistory` gives the MODEL its context and `getConversation`
// gives the USER the transcript — if they walk different paths, the model answers a
// conversation nobody is reading, and nothing on screen would show it. That is the sharpest
// failure mode in cycle 68, so it is asserted directly on a branched fixture.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getConversation, getAgentHistory } = await import('../server/services/conversations')

// drizzle-orm/node-postgres's db.execute() returns a pg `Result`, not a plain array — unwrap
// `.rows` (same correction as test/documents-content-hash.db.test.ts).
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows

const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string
const ids: Record<string, string> = {}

beforeAll(async () => {
  const db = useDb()
  const [conv] = rows<{ id: string }>(await db.execute(
    sql`insert into conversations (title) values (${'zz-path-' + TAG}) returning id`
  ))
  convId = conv!.id
  // a(user) → b(assistant) → c(user) ; and a sibling branch b → d(user)
  const mk = async (key: string, role: string, content: string, parent: string | null) => {
    const [row] = rows<{ id: string }>(await db.execute(sql`
      insert into conversation_messages (conversation_id, parent_id, role, content, modality)
      values (${convId}::uuid, ${parent}::uuid, ${role}, ${content}, 'text') returning id`))
    ids[key] = row!.id
  }
  await mk('a', 'user', 'question A', null)
  await mk('b', 'assistant', 'answer B', ids.a!)
  await mk('c', 'user', 'follow-up C', ids.b!)
  await mk('d', 'user', 'different follow-up D', ids.b!)
})

afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from conversation_messages where conversation_id = ${convId}::uuid`)
  await db.execute(sql`delete from conversations where id = ${convId}::uuid`)
})

async function setLeaf(id: string) {
  await useDb().execute(sql`update conversations set active_leaf_id = ${id}::uuid where id = ${convId}::uuid`)
}

describe('both read paths walk the SAME active path', () => {
  it('agrees on branch C', async () => {
    await setLeaf(ids.c!)
    const ui = (await getConversation(convId))!.messages.map(m => m.content)
    const model = (await getAgentHistory(convId)).map(m => m.content)
    expect(ui).toEqual(['question A', 'answer B', 'follow-up C'])
    expect(model).toEqual(ui)
  })

  it('agrees on branch D, and neither leaks the other branch', async () => {
    await setLeaf(ids.d!)
    const ui = (await getConversation(convId))!.messages.map(m => m.content)
    const model = (await getAgentHistory(convId)).map(m => m.content)
    expect(ui).toEqual(['question A', 'answer B', 'different follow-up D'])
    expect(model).toEqual(ui)
    expect(ui).not.toContain('follow-up C')
  })

  it('falls back to the flat read when no leaf is set rather than showing nothing', async () => {
    await useDb().execute(sql`update conversations set active_leaf_id = null where id = ${convId}::uuid`)
    const ui = (await getConversation(convId))!.messages
    expect(ui.length).toBe(4)          // all rows, today's behaviour
  })
})

describe('branch metadata reaches the DTO', () => {
  it('marks the siblings 1/2 and 2/2 and the trunk 1/1', async () => {
    await setLeaf(ids.c!)
    const msgs = (await getConversation(convId))!.messages
    const c = msgs.find(m => m.content === 'follow-up C')!
    const b = msgs.find(m => m.content === 'answer B')!
    expect(c.branch.total).toBe(2)
    expect(b.branch).toEqual({ index: 1, total: 1 })
    expect(c.parentId).toBe(ids.b)
  })

  // siblingIds is the ONLY way the client can reach a branch it isn't currently reading: the
  // read paths fetch the active path alone, so D never appears in C's transcript. Its consumer
  // lands in a later task, which is precisely why the invariant is pinned now — a silently
  // mis-ordered list would surface there as a pager that switches to the wrong branch.
  it('carries every sibling, in creation order, indexed by branch.index', async () => {
    await setLeaf(ids.c!)
    const msgs = (await getConversation(convId))!.messages
    for (const m of msgs) expect(m.siblingIds[m.branch.index - 1]).toBe(m.id)
    const c = msgs.find(m => m.content === 'follow-up C')!
    expect(c.siblingIds).toEqual([ids.c, ids.d])   // D is unreachable from the path itself
    const a = msgs.find(m => m.content === 'question A')!
    expect(a.siblingIds).toEqual([ids.a])          // a root with no sibling still lists itself
  })
})
