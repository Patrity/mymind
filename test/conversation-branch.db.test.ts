// test/conversation-branch.db.test.ts
//
// Fork, edit and regenerate are ONE primitive: append a child to a chosen parent, then move
// the leaf. Nothing is deleted, which is what makes regenerate non-destructive (it used to
// call truncateForRetry and drop the previous reply).
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { appendMessages, branchParent, getConversation } = await import('../server/services/conversations')

// drizzle-orm/node-postgres's db.execute() returns a pg `Result`, not a plain array — unwrap
// `.rows` (same correction as test/conversation-path.db.test.ts).
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows

const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string
// Every conversation this file creates, so afterAll cleans up even if a test throws midway.
const created: string[] = []

async function newConversation(suffix: string): Promise<string> {
  const [conv] = rows<{ id: string }>(await useDb().execute(
    sql`insert into conversations (title) values (${'zz-branch-' + TAG + suffix}) returning id`
  ))
  created.push(conv!.id)
  return conv!.id
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

describe('appendMessages chains from the active leaf', () => {
  it('builds a linear thread when no parent is given', async () => {
    await appendMessages(convId, [msg('user', 'Q1'), msg('assistant', 'A1')])
    const msgs = (await getConversation(convId))!.messages
    expect(msgs.map(m => m.content)).toEqual(['Q1', 'A1'])
    expect(msgs[0]!.parentId).toBeNull()
    expect(msgs[1]!.parentId).toBe(msgs[0]!.id)
  })

  // NAMED FOR WHAT IT PINS, deliberately. It is tempting to call this "appends to the leaf, not
  // the newest row" — but it cannot prove that, and a name claiming otherwise is how a
  // non-discriminating fixture gets copied into the next task. Every branch this fixture makes
  // is ALSO the newest row, so leaf-chaining and newest-row chaining agree on all of it
  // (measured: reverting the parent selection leaves this green). What it does pin is the leaf
  // MOVE — an explicit parent redirects the active path, and the next append continues from
  // there. The leaf READ is pinned by the pager suite at the bottom of this file, which is the
  // only arrangement where the two rules disagree.
  it('moves the leaf onto an explicitly-parented append, and keeps chaining from it', async () => {
    const before = (await getConversation(convId))!.messages
    const q1 = before.find(m => m.content === 'Q1')!
    // Branch a second answer off Q1. It is newer than A1 but A1 is NOT its parent.
    await appendMessages(convId, [msg('assistant', 'A1-alt')], q1.id)
    const after = (await getConversation(convId))!.messages
    expect(after.map(m => m.content)).toEqual(['Q1', 'A1-alt'])   // the active path moved
    const alt = after.find(m => m.content === 'A1-alt')!
    expect(alt.parentId).toBe(q1.id)
    await appendMessages(convId, [msg('user', 'Q2')])
    const third = (await getConversation(convId))!.messages
    expect(third.map(m => m.content)).toEqual(['Q1', 'A1-alt', 'Q2'])
    expect(third.at(-1)!.parentId).toBe(alt.id)
  })

  it('never deletes: the abandoned branch is still in the table', async () => {
    const all = rows<{ content: string }>(await useDb().execute(
      sql`select content from conversation_messages where conversation_id = ${convId}::uuid`
    ))
    expect(all.map(r => r.content)).toContain('A1')    // the original answer survives
  })
})

describe('branchParent picks the right parent per operation', () => {
  it('fork hangs off the message itself', async () => {
    const msgs = (await getConversation(convId))!.messages
    const target = msgs.find(m => m.content === 'Q1')!
    expect(await branchParent(convId, target.id, 'fork')).toBe(target.id)
  })

  it('edit hangs off the message PARENT, so the edit replaces it as a sibling', async () => {
    const msgs = (await getConversation(convId))!.messages
    const q2 = msgs.find(m => m.content === 'Q2')!
    expect(await branchParent(convId, q2.id, 'edit')).toBe(q2.parentId)
  })

  it('regenerate hangs off the reply PARENT, so the new reply is a sibling of the old', async () => {
    const msgs = (await getConversation(convId))!.messages
    const a = msgs.find(m => m.content === 'A1-alt')!
    expect(await branchParent(convId, a.id, 'regenerate')).toBe(a.parentId)
  })

  // Both ops that read `parentId` must answer null on a root, and that is not an error case:
  // null is the correct parent, making the edited question (or the regenerated first reply) a
  // SECOND ROOT — a sibling of the original, which is the same non-destructive shape as
  // everywhere else. Task 9 branches on this return value, so it is pinned here.
  it('edit of a ROOT message returns null — the edit becomes a second root', async () => {
    const msgs = (await getConversation(convId))!.messages
    const root = msgs.find(m => m.content === 'Q1')!
    expect(root.parentId).toBeNull()                       // guard: Q1 really is a root
    expect(await branchParent(convId, root.id, 'edit')).toBeNull()
  })

  it('regenerate of a ROOT message returns null for the same reason', async () => {
    const msgs = (await getConversation(convId))!.messages
    const root = msgs.find(m => m.content === 'Q1')!
    expect(await branchParent(convId, root.id, 'regenerate')).toBeNull()
  })

  it('returns null for an unknown message rather than throwing', async () => {
    expect(await branchParent(convId, '00000000-0000-4000-8000-000000000000', 'fork')).toBeNull()
  })

  // The only negative case above is an id that exists nowhere, which resolves to null whether or
  // not `branchParent` scopes on the conversation — so it cannot catch a missing conversation_id
  // predicate (measured: dropping it leaves the whole suite green). Task 5 exposes this over
  // HTTP with a USER-SUPPLIED message id, where an unscoped lookup would hand back a parent from
  // someone else's thread and graft a branch across conversations. Hence a real row in a real
  // OTHER conversation, plus the positive control that proves the id itself resolves fine.
  it('refuses a message id that belongs to a DIFFERENT conversation', async () => {
    const other = await newConversation('-other')
    // Two messages, so the one under test has a NON-NULL parent: on a root, edit and regenerate
    // would answer null whether scoped or not, and only the fork assertion would discriminate.
    await appendMessages(other, [msg('user', 'elsewhere-Q'), msg('assistant', 'elsewhere-A')])
    const theirs = (await getConversation(other))!.messages
    const target = theirs.find(m => m.content === 'elsewhere-A')!
    expect(target.parentId).not.toBeNull()                            // guard on the guard

    expect(await branchParent(other, target.id, 'fork')).toBe(target.id)          // control:
    expect(await branchParent(other, target.id, 'edit')).toBe(target.parentId)    // the id is fine
    // ...but not from convId, which does not own it. Unscoped, all three leak a foreign id.
    expect(await branchParent(convId, target.id, 'fork')).toBeNull()
    expect(await branchParent(convId, target.id, 'edit')).toBeNull()
    expect(await branchParent(convId, target.id, 'regenerate')).toBeNull()
  })
})

// The fixture above never separates the leaf from the newest row: every branch it makes is
// also the row written last, so "chain from the leaf" and "chain from the newest row" agree on
// it and it cannot tell the two apart (measured — see the task-4 report's Step 5). This suite
// forces them apart with the move the whole cycle exists for: the user pages BACK to an older
// branch and then types. Its own conversation, so it disturbs nothing above.
describe('the leaf and the newest row differ once the pager moves back', () => {
  let convB: string
  beforeAll(async () => { convB = await newConversation('-pager') })

  it('appends to the branch the pager is on, not to the branch written last', async () => {
    await appendMessages(convB, [msg('user', 'P'), msg('assistant', 'R1')])
    const first = (await getConversation(convB))!.messages
    const p = first.find(m => m.content === 'P')!
    const r1 = first.find(m => m.content === 'R1')!

    // A second reply to P. R2 is now the NEWEST row in the thread by created_at...
    await appendMessages(convB, [msg('assistant', 'R2')], p.id)
    // ...but the user pages back to R1, which is what active_leaf_id records.
    await useDb().execute(sql`update conversations set active_leaf_id = ${r1.id}::uuid where id = ${convB}::uuid`)

    await appendMessages(convB, [msg('user', 'P2')])
    const path = (await getConversation(convB))!.messages
    expect(path.map(m => m.content)).toEqual(['P', 'R1', 'P2'])
    expect(path.at(-1)!.parentId).toBe(r1.id)   // not R2, the newest row
  })
})
