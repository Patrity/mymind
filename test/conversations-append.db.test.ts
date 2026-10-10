// DB-backed — scratch conversations only, deleted in afterAll.
//
// Cycle 75, Task 8: appendMessages' `inTx` hook runs INSIDE the append's transaction, after the
// inserts and the leaf move, with the new ids in insertion order — so a delivery row written
// there commits (or rolls back) together with the assistant message.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { conversations, conversationMessages } from '@mymind/core/db/schema'
import { appendMessages, createConversation } from '@mymind/core/services/conversations'

const convIds: string[] = []
let conv = ''

beforeAll(async () => {
  conv = (await createConversation({ title: 'append-intx-scratch' })).id
  convIds.push(conv)
})

afterAll(async () => {
  if (!convIds.length) return
  await useDb().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await useDb().delete(conversations).where(inArray(conversations.id, convIds))
})

async function state() {
  const [c] = await useDb().select({ leaf: conversations.activeLeafId, n: conversations.messageCount }).from(conversations).where(eq(conversations.id, conv))
  const [r] = await useDb().select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(eq(conversationMessages.conversationId, conv))
  return { leaf: c!.leaf, messageCount: c!.n, rows: r!.n }
}

describe('appendMessages inTx', () => {
  it('runs the hook inside the transaction with the new ids, in order, after the leaf moved', async () => {
    let seen: string[] = []
    let leafInTx: string | null = null
    let rowsInTx = -1
    const ids = await appendMessages(conv, [
      { role: 'user', content: 'q', modality: 'text' },
      { role: 'assistant', content: 'a', modality: 'text' }
    ], undefined, {
      inTx: async (tx, newIds) => {
        seen = [...newIds]
        // Read through the tx: the rows and the leaf move are visible to it already.
        const [c] = await tx.select({ leaf: conversations.activeLeafId }).from(conversations).where(eq(conversations.id, conv))
        leafInTx = c!.leaf
        const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(inArray(conversationMessages.id, newIds))
        rowsInTx = r!.n
      }
    })
    expect(ids).toHaveLength(2)
    expect(seen).toEqual(ids)
    expect(leafInTx).toBe(ids[1])
    expect(rowsInTx).toBe(2)
    const rows = await useDb().select({ id: conversationMessages.id, parentId: conversationMessages.parentId, role: conversationMessages.role })
      .from(conversationMessages).where(inArray(conversationMessages.id, ids))
    expect(rows.find(r => r.id === ids[1])!.parentId).toBe(ids[0])
  })

  it('a throw in the hook rolls back the rows, the count and the leaf, and propagates', async () => {
    const before = await state()
    await expect(appendMessages(conv, [
      { role: 'user', content: 'q2', modality: 'text' },
      { role: 'assistant', content: 'a2', modality: 'text' }
    ], undefined, { inTx: async () => { throw new Error('hook boom') } })).rejects.toThrow('hook boom')
    expect(await state()).toEqual(before)
  })
})
