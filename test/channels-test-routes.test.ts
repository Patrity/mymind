// Cycle 75, Task 11: the Settings → Channels test buttons and the nav status route. Every dep is
// mocked (no DB, no BlueBubbles, no Resend): the handlers are exercised for what they queue,
// what they return, and that the iMessage test always refreshes lastHealth via a forced catch-up.
// requireSession is real (a pure predicate over event.context.client). Pattern: channels-routes.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const mocks = vi.hoisted(() => ({
  load: vi.fn(), resendReady: vi.fn(), client: vi.fn(), catchUp: vi.fn(), health: vi.fn(),
  insert: vi.fn(), publish: vi.fn(), serverInfo: vi.fn()
}))
vi.mock('../server/lib/channels/config', () => ({ loadChannelsConfig: mocks.load, resendReady: mocks.resendReady }))
vi.mock('../server/lib/channels/bluebubbles/client', () => ({
  imessageClient: mocks.client,
  directChatGuid: (h: string) => `iMessage;-;${h}`
}))
vi.mock('../server/lib/channels/inbound', () => ({ catchUpTick: mocks.catchUp, lastHealth: mocks.health }))
vi.mock('../server/lib/channels/outbox', () => ({ insertDeliveries: mocks.insert }))
vi.mock('../server/utils/live-bus', () => ({ publishChange: mocks.publish }))
vi.mock('../server/db', () => ({ useDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn('TX') }) }))

type H = (e: unknown) => Promise<unknown>
const testIMessage = (await import('../server/api/settings/channels/test-imessage.post')).default as H
const testEmail = (await import('../server/api/settings/channels/test-email.post')).default as H
const status = (await import('../server/api/channels/status.get')).default as H

const session = { type: 'session', userId: 'u1' }
const evt = (body: unknown = {}, client: unknown = session) => ({ context: { client }, body })
const info = { privateApi: true, serverVersion: '1.9.9', detectedIcloud: 'me@icloud.com' }
const cfg = (over: { imessage?: object, email?: object } = {}) => ({
  imessage: { enabled: true, serverUrl: 'http://bb', passwordEnc: 'x', webhookToken: 't', allowedHandles: ['+15550001111'], defaultHandle: '+15550001111', defaultChatGuid: null, ...over.imessage },
  email: { enabled: true, to: 'tony@example.com', ...over.email },
  presenceAwayMinutes: 10
})

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset())
  mocks.serverInfo.mockResolvedValue(info)
  mocks.client.mockResolvedValue({ serverInfo: mocks.serverInfo })
  mocks.catchUp.mockResolvedValue({ processed: 0, healthy: true })
  mocks.load.mockResolvedValue(cfg())
  mocks.resendReady.mockResolvedValue(true)
  mocks.insert.mockResolvedValue(['d1'])
})

describe('POST /api/settings/channels/test-imessage', () => {
  it('returns serverInfo, queues nothing, and forces a catch-up tick', async () => {
    expect(await testIMessage(evt({}))).toEqual(info)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.catchUp).toHaveBeenCalledWith({ force: true })
  })

  it('send: true queues the test text to the default chat through the outbox as a note', async () => {
    expect(await testIMessage(evt({ send: true }))).toEqual({ ...info, deliveryId: 'd1' })
    expect(mocks.insert).toHaveBeenCalledWith('TX', [{ channel: 'imessage', target: 'iMessage;-;+15550001111', payload: { text: 'Test from MyMind ✅' }, source: 'note' }])
    expect(mocks.publish).toHaveBeenCalledWith({ resource: 'channelDelivery', action: 'created', id: 'd1' })
    expect(mocks.catchUp).toHaveBeenCalledWith({ force: true })
  })

  it('send targets the cached defaultChatGuid when there is one', async () => {
    mocks.load.mockResolvedValue(cfg({ imessage: { defaultChatGuid: 'iMessage;-;cached' } }))
    await testIMessage(evt({ send: true }))
    expect(mocks.insert.mock.calls[0]![1][0].target).toBe('iMessage;-;cached')
  })

  it('only a literal send: true sends', async () => {
    await testIMessage(evt({ send: 'true' }))
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('send without a default handle → 400, nothing queued', async () => {
    mocks.load.mockResolvedValue(cfg({ imessage: { defaultHandle: null } }))
    await expect(testIMessage(evt({ send: true }))).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('send while iMessage is disabled → 400, nothing queued', async () => {
    mocks.load.mockResolvedValue(cfg({ imessage: { enabled: false } }))
    await expect(testIMessage(evt({ send: true }))).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('no client (not configured) → 400', async () => {
    mocks.client.mockResolvedValue(null)
    await expect(testIMessage(evt({}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('BlueBubbles down → 502, still refreshes health so the status dot turns red, never sends', async () => {
    mocks.serverInfo.mockRejectedValue(new Error('connect ECONNREFUSED'))
    await expect(testIMessage(evt({ send: true }))).rejects.toMatchObject({ statusCode: 502 })
    expect(mocks.catchUp).toHaveBeenCalledWith({ force: true })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('a failing catch-up does not fail the test', async () => {
    mocks.catchUp.mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await testIMessage(evt({}))).toEqual(info)
  })

  it('rejects an api-token caller with 403', async () => {
    await expect(testIMessage(evt({ send: true }, { type: 'api-token' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.client).not.toHaveBeenCalled()
  })
})

describe('POST /api/settings/channels/test-email', () => {
  it('queues a note email to the configured address with subject "Bridget · test"', async () => {
    expect(await testEmail(evt())).toEqual({ deliveryId: 'd1' })
    expect(mocks.insert).toHaveBeenCalledWith('TX', [{ channel: 'email', target: 'tony@example.com', payload: { text: 'Test from MyMind ✅', subject: 'Bridget · test' }, source: 'note' }])
    expect(mocks.publish).toHaveBeenCalledWith({ resource: 'channelDelivery', action: 'created', id: 'd1' })
  })

  it.each([
    ['email disabled', () => mocks.load.mockResolvedValue(cfg({ email: { enabled: false } }))],
    ['no to-address', () => mocks.load.mockResolvedValue(cfg({ email: { to: null } }))],
    ['Resend not ready', () => mocks.resendReady.mockResolvedValue(false)]
  ])('%s → 400, nothing queued', async (_n, arrange) => {
    arrange()
    await expect(testEmail(evt())).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  it('rejects an oauth caller with 403', async () => {
    await expect(testEmail(evt({}, { type: 'oauth' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

describe('GET /api/channels/status', () => {
  it('combines lastHealth with the config', async () => {
    mocks.health.mockReturnValue({ ok: true, privateApi: false, checkedAt: 123 })
    mocks.resendReady.mockResolvedValue(false)
    expect(await status(evt())).toEqual({
      imessage: { enabled: true, ok: true, privateApi: false, checkedAt: 123 },
      email: { enabled: true, ready: false }
    })
  })

  it('carries the health error when the last check failed', async () => {
    mocks.health.mockReturnValue({ ok: false, privateApi: null, checkedAt: 5, error: 'down' })
    mocks.load.mockResolvedValue(cfg({ imessage: { enabled: false }, email: { enabled: false } }))
    expect(await status(evt())).toEqual({
      imessage: { enabled: false, ok: false, privateApi: null, checkedAt: 5, error: 'down' },
      email: { enabled: false, ready: true }
    })
  })
})
