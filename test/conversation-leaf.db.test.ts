// test/conversation-leaf.db.test.ts
//
// setActiveLeaf has two properties the route depends on, neither of which the mocked route
// test (test/conversation-leaf-route.test.ts) can reach: (1) it must SCOPE to the given
// conversation — a message id from elsewhere must be refused, writing nothing — and (2) it must
// resolve the chosen message to its branch TIP before writing, not the message itself. Both are
// proven against the real DB, the same harness as test/conversation-branch.db.test.ts.
//
// Also covers captureTurnLeaf (server/api/voice/ws.ts's turn-start leaf capture, factored out
// for exactly this): a real crossws WS upgrade can't be driven here, but the race it exists to
// prevent — active_leaf_id moving between "turn starts" and "turn persists" — is otherwise
// ordinary DB state, and setActiveLeaf is the real function that moves it mid-turn.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { appendMessages, setActiveLeaf, setBranchLeaf, getConversation, captureTurnLeaf } = await import('../server/services/conversations')

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

/**
 * setBranchLeaf is setActiveLeaf's opposite number: it must NOT descend.
 *
 * The bug it fixes is invisible to every test above, because setActiveLeaf's descent is
 * *correct* for switching branches and only wrong for creating one. Routing a fork through it
 * lands the leaf back on the tip of the branch being forked — so "fork from message M" and "just
 * carry on typing" become the same operation, and the fork silently does nothing.
 */
describe('setBranchLeaf sets branchParent\'s answer exactly, with no descent', () => {
  // Q1 -> A1 -> Q2 -> A2, all on one trunk. Forking from A1 is the interesting case: it has
  // descendants, so a descending resolver would walk past it to A2.
  async function trunk() {
    const conv = await newConversation('-branchleaf-' + Math.random().toString(16).slice(2, 8))
    await appendMessages(conv, [msg('user', 'Q1'), msg('assistant', 'A1')])
    await appendMessages(conv, [msg('user', 'Q2'), msg('assistant', 'A2')])
    const all = rows<{ id: string, content: string, parent_id: string | null }>(await useDb().execute(
      sql`select id, content, parent_id from conversation_messages where conversation_id = ${conv}::uuid order by created_at, id`
    ))
    return { conv, byContent: (c: string) => all.find(r => r.content === c)! }
  }

  it('fork lands on the message ITSELF, where setActiveLeaf would have descended to the branch tip', async () => {
    const { conv, byContent } = await trunk()
    const a1 = byContent('A1')
    const a2 = byContent('A2')

    // The defect, demonstrated first: the descending resolver walks A1 -> Q2 -> A2.
    expect(await setActiveLeaf(conv, a1.id)).toBe(a2.id)

    // setBranchLeaf does not. The leaf is A1 exactly, so the next turn continues FROM A1.
    expect(await setBranchLeaf(conv, a1.id, 'fork')).toBe(a1.id)
    expect(await activeLeafOf(conv)).toBe(a1.id)

    // And a turn appended from there really does hang off A1 — a sibling of Q2, not its child.
    await appendMessages(conv, [msg('user', 'Q2-fork'), msg('assistant', 'A2-fork')])
    const forked = rows<{ parent_id: string | null, content: string }>(await useDb().execute(
      sql`select parent_id, content from conversation_messages where conversation_id = ${conv}::uuid`
    )).find(r => r.content === 'Q2-fork')!
    expect(forked.parent_id).toBe(a1.id)
    // The original continuation is untouched and still reachable.
    expect(byContent('Q2').parent_id).toBe(a1.id)
  })

  it('edit lands on the target\'s PARENT, so the rewritten turn is a sibling of the original', async () => {
    const { conv, byContent } = await trunk()
    const q2 = byContent('Q2')
    const a1 = byContent('A1')

    expect(await setBranchLeaf(conv, q2.id, 'edit')).toBe(a1.id)
    expect(await activeLeafOf(conv)).toBe(a1.id)

    await appendMessages(conv, [msg('user', 'Q2-edited'), msg('assistant', 'A2-edited')])
    const edited = rows<{ parent_id: string | null, content: string }>(await useDb().execute(
      sql`select parent_id, content from conversation_messages where conversation_id = ${conv}::uuid`
    )).find(r => r.content === 'Q2-edited')!
    expect(edited.parent_id).toBe(a1.id)
    expect(edited.parent_id).toBe(byContent('Q2').parent_id)   // siblings, not a rewrite

    // Both versions of the question are now reachable, and the pager can see two of them.
    const path = (await getConversation(conv))!.messages
    expect(path.map(m => m.content)).toEqual(['Q1', 'A1', 'Q2-edited', 'A2-edited'])
    const onPath = path.find(m => m.content === 'Q2-edited')!
    expect(onPath.branch).toEqual({ index: 2, total: 2 })
    expect(onPath.siblingIds).toEqual([byContent('Q2').id, onPath.id])
  })

  it('regenerate lands on the reply\'s parent — kept tested even though the UI reaches it via edit', async () => {
    const { conv, byContent } = await trunk()
    expect(await setBranchLeaf(conv, byContent('A2').id, 'regenerate')).toBe(byContent('Q2').id)
    expect(await activeLeafOf(conv)).toBe(byContent('Q2').id)
  })

  it('returns null and writes NOTHING for a root (no parent a leaf column can express) and for a foreign id', async () => {
    const { conv, byContent } = await trunk()
    await setBranchLeaf(conv, byContent('A1').id, 'fork')
    const before = await activeLeafOf(conv)

    // Q1 is the root: an edit of it would have to become a SECOND root, which active_leaf_id
    // cannot say. null, and the route turns that into a 404.
    expect(await setBranchLeaf(conv, byContent('Q1').id, 'edit')).toBeNull()
    expect(await activeLeafOf(conv)).toBe(before)

    // ...but a FORK of that same root is fine — it hangs off the root itself.
    expect(await setBranchLeaf(conv, byContent('Q1').id, 'fork')).toBe(byContent('Q1').id)

    // Scoping: a real message id from another conversation must be refused, writing nothing.
    const other = await newConversation('-branchleaf-other')
    await appendMessages(other, [msg('user', 'elsewhere-Q'), msg('assistant', 'elsewhere-A')])
    const theirs = (await getConversation(other))!.messages.find(m => m.content === 'elsewhere-A')!
    const beforeForeign = await activeLeafOf(conv)
    expect(await setBranchLeaf(conv, theirs.id, 'fork')).toBeNull()
    expect(await activeLeafOf(conv)).toBe(beforeForeign)
  })
})

describe('captureTurnLeaf', () => {
  it('returns the active leaf when one is set', async () => {
    const conv = await newConversation('-capture-set')
    await appendMessages(conv, [msg('user', 'Q'), msg('assistant', 'A')])
    const leaf = await activeLeafOf(conv)
    expect(leaf).not.toBeNull()
    expect(await captureTurnLeaf(conv)).toBe(leaf)
  })

  it('returns undefined, NOT null, for a conversation with no leaf yet — appendMessages(id, msgs, null) would start a new root and orphan it', async () => {
    const conv = await newConversation('-capture-empty')
    expect(await activeLeafOf(conv)).toBeNull()
    expect(await captureTurnLeaf(conv)).toBeUndefined()
  })

  it('freezes the branch a turn writes into: appendMessages(conv, msgs, captured) lands under the CAPTURED parent even after setActiveLeaf moves the live leaf elsewhere', async () => {
    const conv = await newConversation('-capture-race')
    // Q1 -> A1, then a sibling reply A1-alt (both branches reachable; leaf now on A1-alt).
    await appendMessages(conv, [msg('user', 'Q1'), msg('assistant', 'A1')])
    const q1 = (await getConversation(conv))!.messages.find(m => m.content === 'Q1')!
    await appendMessages(conv, [msg('assistant', 'A1-alt')], q1.id)

    const branchRows = rows<{ id: string, content: string }>(await useDb().execute(
      sql`select id, content from conversation_messages where conversation_id = ${conv}::uuid`
    ))
    const a1 = branchRows.find(r => r.content === 'A1')!
    const a1alt = branchRows.find(r => r.content === 'A1-alt')!

    // A tab reading the A1 branch is about to send a turn into it — switch the live leaf
    // there first (A1 has no children of its own, so it resolves to itself).
    await setActiveLeaf(conv, a1.id)
    const captured = await captureTurnLeaf(conv)
    expect(captured).toBe(a1.id)

    // Meanwhile — another tab, or the same one switching branches mid-reply — moves the LIVE
    // leaf back onto the other branch while the captured turn is still "in flight".
    await setActiveLeaf(conv, a1alt.id)
    expect(await activeLeafOf(conv)).toBe(a1alt.id)
    expect(await activeLeafOf(conv)).not.toBe(captured)

    // The turn persists using the id captured at ITS start, not wherever the leaf drifted to.
    await appendMessages(conv, [msg('user', 'Q2'), msg('assistant', 'A2')], captured)

    const q2 = (rows<{ id: string, parent_id: string | null, content: string }>(await useDb().execute(
      sql`select id, parent_id, content from conversation_messages where conversation_id = ${conv}::uuid order by created_at`
    ))).find(r => r.content === 'Q2')!
    expect(q2.parent_id).toBe(captured)
    expect(q2.parent_id).not.toBe(a1alt.id)
  })
})
