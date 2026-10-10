// DB-backed — cycle 75, Task 3: channel settings round-trip, token stability, webhook-token check.
// The dev DB is SHARED and these are REAL settings keys: every row is snapshotted in beforeAll and
// restored exactly in afterAll (deleted if it was absent). No other rows are touched.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { settings, type SettingRow } from '@mymind/core/db/schema'
import {
  loadChannelsConfig, saveChannelsConfig, invalidateChannelsConfig, verifyWebhookToken, blueBubblesPassword,
  mergeChannelsPut, rotateWebhookToken, type ChannelsConfig
} from '@mymind/core/lib/channels/config'
import { isAway, markActive, _resetPresence } from '@mymind/core/lib/channels/presence'
import { encryptSecret } from '@mymind/core/lib/ai/registry/crypto'

const KEYS = ['channel_imessage', 'channel_email', 'presence_away_minutes']
let snapshot: SettingRow[] = []

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ||= 'test-secret-test-secret-test-secret'
  snapshot = await useDb().select().from(settings).where(inArray(settings.key, KEYS))
})

afterAll(async () => {
  const db = useDb()
  await db.delete(settings).where(inArray(settings.key, KEYS))
  if (snapshot.length) await db.insert(settings).values(snapshot)
  invalidateChannelsConfig()
})

async function clearKeys() {
  await useDb().delete(settings).where(inArray(settings.key, KEYS))
  invalidateChannelsConfig()
}

describe('channel settings (DB)', () => {
  it('generates a webhook token once on first load and keeps it stable', async () => {
    await clearKeys()
    const first = await loadChannelsConfig()
    expect(first.imessage.webhookToken).toMatch(/^[0-9a-f]{64}$/)
    expect(first.imessage.enabled).toBe(false)
    expect(first.presenceAwayMinutes).toBe(10)
    const [row] = await useDb().select().from(settings).where(inArray(settings.key, ['channel_imessage']))
    expect((row!.value as { webhookToken: string }).webhookToken).toBe(first.imessage.webhookToken)

    invalidateChannelsConfig()
    const second = await loadChannelsConfig()
    expect(second.imessage.webhookToken).toBe(first.imessage.webhookToken)
  })

  it('round-trips save → load across all three keys', async () => {
    const current = await loadChannelsConfig()
    const c: ChannelsConfig = {
      imessage: {
        enabled: true, serverUrl: 'http://bb-test.invalid:1234', passwordEnc: encryptSecret('pw-test'),
        webhookToken: current.imessage.webhookToken, allowedHandles: ['+15550000001'],
        defaultHandle: '+15550000001', defaultChatGuid: 'iMessage;-;+15550000001'
      },
      email: { enabled: true, to: 'test@example.invalid' },
      presenceAwayMinutes: 25
    }
    await saveChannelsConfig(c)
    invalidateChannelsConfig()
    const loaded = await loadChannelsConfig()
    expect(loaded).toEqual(c)
    expect(blueBubblesPassword(loaded.imessage)).toBe('pw-test')
    const rows = await useDb().select().from(settings).where(inArray(settings.key, KEYS))
    expect(rows.map(r => r.key).sort()).toEqual([...KEYS].sort())
  })

  it('verifyWebhookToken: true for the right token, false for wrong / wrong length / missing / disabled', async () => {
    const c = await loadChannelsConfig()
    const token = c.imessage.webhookToken
    await saveChannelsConfig({ ...c, imessage: { ...c.imessage, enabled: true } })
    invalidateChannelsConfig()

    expect(await verifyWebhookToken(token)).toBe(true)
    const wrong = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
    expect(await verifyWebhookToken(wrong)).toBe(false)
    expect(await verifyWebhookToken(token.slice(0, -1))).toBe(false)
    expect(await verifyWebhookToken(token + '0')).toBe(false)
    expect(await verifyWebhookToken(undefined)).toBe(false)
    expect(await verifyWebhookToken('')).toBe(false)

    await saveChannelsConfig({ ...c, imessage: { ...c.imessage, enabled: false } })
    invalidateChannelsConfig()
    expect(await verifyWebhookToken(token)).toBe(false)
  })
})

async function storedToken(): Promise<unknown> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, 'channel_imessage'))
  return (row?.value as { webhookToken?: unknown } | undefined)?.webhookToken
}
const tokenOf = (dto: { imessage: { webhookUrlPath: string } }) => dto.imessage.webhookUrlPath.split('token=')[1]!

describe('webhook token is only changed by rotation (DB)', () => {
  it('save ignores a different token in the config it is given', async () => {
    const c = await loadChannelsConfig()
    const before = c.imessage.webhookToken
    await saveChannelsConfig({ ...c, imessage: { ...c.imessage, webhookToken: 'f'.repeat(64) } })
    expect(await storedToken()).toBe(before)
    invalidateChannelsConfig()
    expect((await loadChannelsConfig()).imessage.webhookToken).toBe(before)
  })

  it('a PUT that loaded before a concurrent regenerate does not undo the rotation', async () => {
    invalidateChannelsConfig()
    const stale = await loadChannelsConfig()
    const rotated = await rotateWebhookToken()
    expect(rotated).not.toBe(stale.imessage.webhookToken)
    const merged = mergeChannelsPut(stale, {
      imessage: { enabled: true, serverUrl: 'http://bb-test.invalid:1234', password: null, allowedHandles: ['+15550000002'], defaultHandle: null },
      email: { enabled: false, to: null },
      presenceAwayMinutes: 12
    })
    expect(merged.imessage.webhookToken).toBe(stale.imessage.webhookToken) // the stale value is in hand...
    await saveChannelsConfig(merged)
    expect(await storedToken()).toBe(rotated) // ...but the stored rotated token survives
    invalidateChannelsConfig()
    const after = await loadChannelsConfig()
    expect(after.imessage.webhookToken).toBe(rotated)
    expect(after.imessage.allowedHandles).toEqual(['+15550000002'])
    expect(after.presenceAwayMinutes).toBe(12)
  })

  it('POST regenerate-token (session): new token differs, the old one stops verifying', async () => {
    const regen = (await import('../server/api/settings/channels/regenerate-token.post')).default as (e: unknown) => Promise<{ imessage: { webhookUrlPath: string } }>
    invalidateChannelsConfig()
    const c = await loadChannelsConfig()
    await saveChannelsConfig({ ...c, imessage: { ...c.imessage, enabled: true } })
    invalidateChannelsConfig()
    const old = (await loadChannelsConfig()).imessage.webhookToken
    expect(await verifyWebhookToken(old)).toBe(true)

    const dto = await regen({ context: { client: { type: 'session', userId: 'u1' } } })
    const fresh = tokenOf(dto)
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect(fresh).not.toBe(old)
    expect(await storedToken()).toBe(fresh)
    expect(await verifyWebhookToken(old)).toBe(false)
    expect(await verifyWebhookToken(fresh)).toBe(true)
  })
})

describe('malformed stored rows never throw (DB)', () => {
  afterEach(() => { vi.restoreAllMocks(); _resetPresence() })

  async function writeRaw(rows: Array<{ key: string, value: unknown }>) {
    await clearKeys()
    await useDb().insert(settings).values(rows.map(r => ({ ...r, value: r.value as object })))
    invalidateChannelsConfig()
  }

  it('bad field types fall back; a valid token is kept and verifies; isAway works', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tok = 'd'.repeat(64)
    await writeRaw([
      { key: 'channel_imessage', value: { enabled: true, serverUrl: 5, webhookToken: tok, allowedHandles: 'x' } },
      { key: 'channel_email', value: 'not-an-object' },
      { key: 'presence_away_minutes', value: 'ten' }
    ])
    const c = await loadChannelsConfig()
    expect(c.imessage.enabled).toBe(true)
    expect(c.imessage.serverUrl).toBe('')
    expect(c.imessage.allowedHandles).toEqual([])
    expect(c.imessage.webhookToken).toBe(tok)
    expect(c.email).toEqual({ enabled: false, to: null })
    expect(c.presenceAwayMinutes).toBe(10)
    expect(warn).toHaveBeenCalled()
    expect(await verifyWebhookToken(tok)).toBe(true)
    expect(await verifyWebhookToken('e'.repeat(64))).toBe(false)
    const t0 = Date.now()
    markActive(t0)
    expect(await isAway(t0 + 60_000)).toBe(false)
    expect(await isAway(t0 + 10 * 60_000)).toBe(true)
  })

  it('a non-object / bad-token iMessage row is repaired with a fresh persisted token; verify stays false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeRaw([{ key: 'channel_imessage', value: 12345 }])
    const c = await loadChannelsConfig()
    expect(c.imessage.enabled).toBe(false)
    expect(c.imessage.webhookToken).toMatch(/^[0-9a-f]{64}$/)
    expect(await storedToken()).toBe(c.imessage.webhookToken)
    expect(await verifyWebhookToken(c.imessage.webhookToken)).toBe(false) // disabled
    expect(await isAway()).toBe(true)

    await writeRaw([{ key: 'channel_imessage', value: { enabled: true, webhookToken: 99 } }])
    const d = await loadChannelsConfig()
    expect(d.imessage.webhookToken).toMatch(/^[0-9a-f]{64}$/)
    expect(await storedToken()).toBe(d.imessage.webhookToken)
    expect(await verifyWebhookToken('99')).toBe(false)
    expect(await verifyWebhookToken(d.imessage.webhookToken)).toBe(true)
  })
})
