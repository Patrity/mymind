// DB-backed — cycle 79, Task 1: connections upsert / reconnect / cascade.
// The dev DB is SHARED with real data: this file inserts its own user + account rows with random
// ids and deletes them in finally. No other rows are touched.
process.loadEnvFile('.env')

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq } from 'drizzle-orm'
import { useDb } from '../server/db'
import { user, account, connections } from '../server/db/schema'
import { upsertConnectionForAccount, listConnections, markReconnect, touchConnection } from '../server/lib/google/connections'

function unsignedJwt(payload: Record<string, unknown>) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`
}

describe('connections (DB)', () => {
  it('upsert creates a labelled row, reconnect resets status, account delete cascades', async () => {
    const db = useDb()
    const rand = randomUUID().slice(0, 8)
    const userId = `test-user-${rand}`
    const accId = `test-acc-${rand}`
    const sub = `sub-test-${rand}`
    // Unique domain per run so the label can't collide with a real connection.
    const email = `t@conntest${rand}.example`
    try {
      await db.insert(user).values({ id: userId, name: 'Conn Test', email: `conn-${rand}@test.invalid` })
      await db.insert(account).values({
        id: accId, accountId: sub, providerId: 'google', userId,
        idToken: unsignedJwt({ sub, email })
      })

      await upsertConnectionForAccount({ id: accId, providerId: 'google', accountId: sub, idToken: unsignedJwt({ sub, email }) })
      const [row] = await db.select().from(connections).where(eq(connections.accountId, accId))
      expect(row).toBeTruthy()
      expect(row!.email).toBe(email)
      expect(row!.label).toBe(`conntest${rand}`)
      expect(row!.status).toBe('ok')

      const listed = (await listConnections()).find(c => c.accountId === accId)
      expect(listed).toMatchObject({ id: row!.id, userId, googleSub: sub, provider: 'google', email, status: 'ok', lastError: null })

      await markReconnect(row!.id, 'revoked')
      const [marked] = await db.select().from(connections).where(eq(connections.id, row!.id))
      expect(marked!.status).toBe('needs_reconnect')
      expect(marked!.lastError).toBe('revoked')
      expect((await listConnections({ status: 'ok' })).some(c => c.id === row!.id)).toBe(false)

      // Reconnect path: the account update hook re-runs the upsert.
      await upsertConnectionForAccount({ id: accId, providerId: 'google', accountId: sub, idToken: unsignedJwt({ sub, email }) })
      const [again] = await db.select().from(connections).where(eq(connections.accountId, accId))
      expect(again!.id).toBe(row!.id)
      expect(again!.label).toBe(row!.label)
      expect(again!.status).toBe('ok')
      expect(again!.lastError).toBeNull()

      await touchConnection(row!.id)
      const [touched] = await db.select().from(connections).where(eq(connections.id, row!.id))
      expect(touched!.lastUsedAt).toBeInstanceOf(Date)

      // Non-google accounts are ignored.
      await upsertConnectionForAccount({ id: accId, providerId: 'credential', accountId: userId })

      await db.delete(account).where(eq(account.id, accId))
      const gone = await db.select().from(connections).where(eq(connections.accountId, accId))
      expect(gone).toHaveLength(0)
    } finally {
      await db.delete(account).where(eq(account.id, accId))
      await db.delete(user).where(eq(user.id, userId))
    }
  })

  it('M1: tokensUndecryptable is true only when the stored tokens fail to decrypt under the current secret', async () => {
    const { setTokenUtil } = await import('better-auth/oauth2')
    const { connectionDeps } = await import('../server/lib/google/connections')
    const ctxFor = (secret: string) => ({ options: { account: { encryptOAuthTokens: true } }, secretConfig: secret })
    const OLD = 'old-secret-old-secret-old-secret-0001'
    const NEW = 'new-secret-new-secret-new-secret-0002'
    const db = useDb()
    const rand = randomUUID().slice(0, 8)
    const userId = `test-user-m1-${rand}`
    const accId = `test-acc-m1-${rand}`
    const conn = { id: 'unused', accountId: accId, userId, googleSub: `sub-m1-${rand}`, provider: 'google' as const, label: 'x', email: 'x@x.example', status: 'ok' as const, lastError: null }
    try {
      await db.insert(user).values({ id: userId, name: 'M1 Test', email: `m1-${rand}@test.invalid` })
      await db.insert(account).values({
        id: accId, accountId: conn.googleSub, providerId: 'google', userId,
        refreshToken: await setTokenUtil('1//refresh', ctxFor(OLD) as never), accessToken: await setTokenUtil('ya29.at', ctxFor(OLD) as never)
      })
      vi.stubGlobal('useAuth', () => ({ $context: Promise.resolve(ctxFor(OLD)) }))
      expect(await connectionDeps.tokensUndecryptable(conn)).toBe(false)
      vi.stubGlobal('useAuth', () => ({ $context: Promise.resolve(ctxFor(NEW)) }))
      expect(await connectionDeps.tokensUndecryptable(conn)).toBe(true)
      // A missing account row (or a lookup failure) is "can't tell" → false.
      expect(await connectionDeps.tokensUndecryptable({ ...conn, accountId: `missing-${rand}` })).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
      await db.delete(account).where(eq(account.id, accId))
      await db.delete(user).where(eq(user.id, userId))
    }
  })
})
