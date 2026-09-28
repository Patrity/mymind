// DB-backed — cycle 75, Task 3: channel settings round-trip, token stability, webhook-token check.
// The dev DB is SHARED and these are REAL settings keys: every row is snapshotted in beforeAll and
// restored exactly in afterAll (deleted if it was absent). No other rows are touched.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { settings, type SettingRow } from '../server/db/schema'
import {
  loadChannelsConfig, saveChannelsConfig, invalidateChannelsConfig, verifyWebhookToken, blueBubblesPassword,
  type ChannelsConfig
} from '../server/lib/channels/config'
import { encryptSecret } from '../server/lib/ai/registry/crypto'

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
