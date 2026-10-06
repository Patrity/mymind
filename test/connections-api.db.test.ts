// DB-backed — cycle 79, Task 6: GET/PATCH/DELETE /api/connections.
// The dev DB is SHARED with real data: this file inserts its own user + account + connection rows
// with random ids and deletes them in finally. Google is never reached — the revoke goes through
// connectionsApiDeps.fetch (stubbed) and decrypt is stubbed to identity.
process.loadEnvFile('.env')

import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL, googleClientId: 'cid', googleClientSecret: 'csecret' }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { user, account, connections } from '../server/db/schema'
import { connectionsApiDeps } from '../server/lib/google/manage'

type H = (e: unknown) => Promise<unknown>
const list = (await import('../server/api/connections/index.get')).default as H
const patch = (await import('../server/api/connections/[id].patch')).default as H
const del = (await import('../server/api/connections/[id].delete')).default as H

const session = { type: 'session', userId: 'u1' }
const evt = (client: unknown, params: Record<string, string> = {}, body: unknown = undefined) => ({ context: { client }, params, body })

const realFetch = connectionsApiDeps.fetch
const realDecrypt = connectionsApiDeps.decrypt
afterEach(() => { connectionsApiDeps.fetch = realFetch; connectionsApiDeps.decrypt = realDecrypt })

async function fixture() {
  const db = useDb()
  const rand = randomUUID().slice(0, 8)
  const userId = `test-user-${rand}`
  const credId = `test-cred-${rand}`
  const accA = `test-acc-a-${rand}`
  const accB = `test-acc-b-${rand}`
  await db.insert(user).values({ id: userId, name: 'Conn API Test', email: `connapi-${rand}@test.invalid` })
  await db.insert(account).values([
    { id: credId, accountId: userId, providerId: 'credential', userId, password: 'x' },
    { id: accA, accountId: `sub-a-${rand}`, providerId: 'google', userId, refreshToken: `rt-a-${rand}`, accessToken: `at-a-${rand}`, scope: 'openid,email,https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' },
    { id: accB, accountId: `sub-b-${rand}`, providerId: 'google', userId, accessToken: `at-b-${rand}`, scope: null }
  ])
  const [a] = await db.insert(connections).values({ accountId: accA, provider: 'google', label: `ta-${rand}`, email: `a-${rand}@x.example` }).returning()
  const [b] = await db.insert(connections).values({ accountId: accB, provider: 'google', label: `tb-${rand}`, email: `b-${rand}@x.example`, status: 'needs_reconnect', lastError: 'revoked' }).returning()
  const cleanup = async () => {
    await db.delete(account).where(inArray(account.id, [credId, accA, accB]))
    await db.delete(user).where(eq(user.id, userId))
  }
  return { rand, userId, credId, accA, accB, a: a!, b: b!, cleanup }
}

describe('connections API (DB)', () => {
  it.each([['api-token'], ['oauth'], [undefined]])('rejects a %s client with 403 on every route', async (type) => {
    const client = type ? { type, tokenId: 't' } : undefined
    await expect(list(evt(client))).rejects.toMatchObject({ statusCode: 403 })
    await expect(patch(evt(client, { id: 'x' }, { label: 'y' }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(del(evt(client, { id: 'x' }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('GET lists connections with configured + parsed scopes', async () => {
    const f = await fixture()
    try {
      const res = await list(evt(session)) as { configured: boolean, connections: Array<Record<string, unknown>> }
      expect(res.configured).toBe(true)
      const a = res.connections.find(c => c.id === f.a.id)
      const b = res.connections.find(c => c.id === f.b.id)
      expect(a).toEqual({
        id: f.a.id, provider: 'google', label: `ta-${f.rand}`, email: `a-${f.rand}@x.example`,
        status: 'ok', lastError: null, lastUsedAt: null,
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events']
      })
      expect(b).toMatchObject({ status: 'needs_reconnect', lastError: 'revoked', scopes: [] })
      // Tokens never leave the server.
      expect(JSON.stringify(res)).not.toContain(`rt-a-${f.rand}`)
      expect(JSON.stringify(res)).not.toContain(`at-a-${f.rand}`)
    } finally { await f.cleanup() }
  })

  it('PATCH validates the label, 409s on a duplicate, and renames', async () => {
    const f = await fixture()
    try {
      for (const bad of ['', 'Upper', '-lead', 'has space', 'a'.repeat(33), 42]) {
        await expect(patch(evt(session, { id: f.a.id }, { label: bad }))).rejects.toMatchObject({ statusCode: 400 })
      }
      await expect(patch(evt(session, { id: f.a.id }, { label: `tb-${f.rand}` }))).rejects.toMatchObject({ statusCode: 409 })
      await expect(patch(evt(session, { id: randomUUID() }, { label: 'whatever' }))).rejects.toMatchObject({ statusCode: 404 })

      const renamed = await patch(evt(session, { id: f.a.id }, { label: `work-${f.rand}` })) as { label: string, id: string }
      expect(renamed).toMatchObject({ id: f.a.id, label: `work-${f.rand}` })
      const [row] = await useDb().select().from(connections).where(eq(connections.id, f.a.id))
      expect(row!.label).toBe(`work-${f.rand}`)
      // Same label on itself is not a clash.
      await expect(patch(evt(session, { id: f.a.id }, { label: `work-${f.rand}` }))).resolves.toMatchObject({ label: `work-${f.rand}` })
    } finally { await f.cleanup() }
  })

  it('DELETE revokes the refresh token at Google, then deletes the account (connection cascades), credential untouched', async () => {
    const f = await fixture()
    const calls: Array<{ url: string, method?: string }> = []
    connectionsApiDeps.decrypt = async t => `plain:${t}`
    connectionsApiDeps.fetch = async (url, init) => { calls.push({ url, method: init?.method }); return new Response('', { status: 200 }) }
    try {
      const res = await del(evt(session, { id: f.a.id })) as { revoked: boolean }
      expect(res.revoked).toBe(true)
      expect(calls).toEqual([{ url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(`plain:rt-a-${f.rand}`)}`, method: 'POST' }])
      const db = useDb()
      expect(await db.select().from(account).where(eq(account.id, f.accA))).toHaveLength(0)
      expect(await db.select().from(connections).where(eq(connections.id, f.a.id))).toHaveLength(0)
      expect(await db.select().from(account).where(eq(account.id, f.credId))).toHaveLength(1)
      expect(await db.select().from(account).where(eq(account.id, f.accB))).toHaveLength(1)
      await expect(del(evt(session, { id: f.a.id }))).rejects.toMatchObject({ statusCode: 404 })
    } finally { await f.cleanup() }
  })

  it('DELETE still deletes locally when the Google revoke fails (falls back to the access token)', async () => {
    const f = await fixture()
    const calls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    connectionsApiDeps.decrypt = async t => t
    connectionsApiDeps.fetch = async (url) => { calls.push(url); throw new Error('network down') }
    try {
      const res = await del(evt(session, { id: f.b.id })) as { revoked: boolean }
      expect(res.revoked).toBe(false)
      expect(calls).toEqual([`https://oauth2.googleapis.com/revoke?token=at-b-${f.rand}`])
      expect(warn).toHaveBeenCalled()
      expect(await useDb().select().from(account).where(eq(account.id, f.accB))).toHaveLength(0)
      expect(await useDb().select().from(account).where(eq(account.id, f.credId))).toHaveLength(1)
    } finally { warn.mockRestore(); await f.cleanup() }
  })
})
