// Cycle 75, Task 11: a conversation read carries each assistant row's channel deliveries (one
// query), and the /agent live badge refresh reads them per conversation.
//
// Dev DB is shared (db-safety.md): a scratch conversation with a unique title, and delivery rows
// in statuses no worker ever claims (sent / failed, and sent_unconfirmed on EMAIL — only iMessage
// rows are confirmed by catch-up) so another dev server's tick can never pick them up. Everything
// is deleted by id in afterAll.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getConversation, deliveriesByMessage, conversationDeliveries } = await import('../server/services/conversations')

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows
const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string
const ids: Record<string, string> = {}
const deliveryIds: string[] = []

beforeAll(async () => {
  const db = useDb()
  const [conv] = rows<{ id: string }>(await db.execute(sql`insert into conversations (title) values (${'zz-deliv-' + TAG}) returning id`))
  convId = conv!.id
  const mk = async (key: string, role: string, parent: string | null, origin: string | null = null) => {
    const [row] = rows<{ id: string }>(await db.execute(sql`
      insert into conversation_messages (conversation_id, parent_id, role, content, modality, origin)
      values (${convId}::uuid, ${parent}::uuid, ${role}, ${key}, 'text', ${origin}) returning id`))
    ids[key] = row!.id
  }
  await mk('q1', 'user', null, 'imessage:iMessage;-;+15550001111')
  await mk('a1', 'assistant', ids.q1!)
  await mk('q2', 'user', ids.a1!)
  await mk('a2', 'assistant', ids.q2!)
  const dv = async (messageId: string, channel: string, status: string) => {
    const [row] = rows<{ id: string }>(await db.execute(sql`
      insert into channel_deliveries (channel, target, conversation_id, message_id, source, payload, status)
      values (${channel}, ${'zz-deliv-' + TAG}, ${convId}::uuid, ${messageId}::uuid, 'reply', ${JSON.stringify({ text: 'x' })}::jsonb, ${status}) returning id`))
    deliveryIds.push(row!.id)
  }
  await dv(ids.a1!, 'imessage', 'sent')
  await dv(ids.a1!, 'imessage', 'failed')
  await dv(ids.a1!, 'email', 'sent_unconfirmed')
})

afterAll(async () => {
  const db = useDb()
  if (deliveryIds.length) await db.execute(sql`delete from channel_deliveries where id = any(${sql.param(deliveryIds)}::uuid[])`)
  await db.execute(sql`delete from conversation_messages where conversation_id = ${convId}::uuid`)
  await db.execute(sql`delete from conversations where id = ${convId}::uuid`)
})

describe('conversation deliveries', () => {
  it('getConversation puts deliveries on the assistant row that owns them, and nowhere else', async () => {
    const r = await getConversation(convId)
    const byContent = Object.fromEntries(r!.messages.map(m => [m.content, m]))
    expect(byContent.a1!.deliveries).toEqual([
      { channel: 'imessage', status: 'sent' },
      { channel: 'imessage', status: 'failed' },
      { channel: 'email', status: 'sent_unconfirmed' }
    ])
    expect(byContent.a2).not.toHaveProperty('deliveries')
    expect(byContent.q1).not.toHaveProperty('deliveries')
    expect(byContent.q1!.origin).toBe('imessage:iMessage;-;+15550001111')
  })

  it('deliveriesByMessage binds any number of ids (one array parameter) and ignores unknown ids', async () => {
    const many = [ids.a1!, ids.a2!, ...Array.from({ length: 2000 }, () => crypto.randomUUID())]
    const map = await deliveriesByMessage(many)
    expect([...map.keys()]).toEqual([ids.a1])
    expect(map.get(ids.a1!)).toHaveLength(3)
    expect((await deliveriesByMessage([])).size).toBe(0)
  })

  it('conversationDeliveries lists every delivery in the conversation with its message id', async () => {
    const list = await conversationDeliveries(convId)
    expect(list).toHaveLength(3)
    expect(list.every(d => d.messageId === ids.a1)).toBe(true)
    expect(list.map(d => d.status)).toEqual(['sent', 'failed', 'sent_unconfirmed'])
  })
})
