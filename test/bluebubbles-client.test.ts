// test/bluebubbles-client.test.ts
// The BlueBubbles REST client and the iMessage adapter, against the in-process fake server
// (test/fixtures/fake-bluebubbles.ts). DB-free: config and image reads are mocked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startFakeBlueBubbles, type FakeBlueBubbles } from './fixtures/fake-bluebubbles'

const mocks = vi.hoisted(() => ({
  loadChannelsConfig: vi.fn(),
  getImageBytes: vi.fn()
}))
vi.mock('../server/lib/channels/config', () => ({
  loadChannelsConfig: mocks.loadChannelsConfig,
  blueBubblesPassword: (c: { passwordEnc: string | null }) => c.passwordEnc
}))
vi.mock('../server/services/images', () => ({ getImageBytes: mocks.getImageBytes }))

const { blueBubblesClient, BlueBubblesError, imessageClient } = await import('../server/lib/channels/bluebubbles/client')
const { imessageChannel } = await import('../server/lib/channels/bluebubbles/channel')
const { channelFor } = await import('../server/lib/channels/registry')

const CHAT = 'iMessage;-;+15551234567'

let fake: FakeBlueBubbles
afterEach(async () => {
  await fake?.close()
  delete process.env.BLUEBUBBLES_FAKE_URL
  vi.clearAllMocks()
})

function client(extra: Partial<Parameters<typeof blueBubblesClient>[0]> = {}) {
  return blueBubblesClient({ serverUrl: fake.url, password: fake.password, ...extra })
}

async function rejection(p: Promise<unknown>): Promise<InstanceType<typeof BlueBubblesError>> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(BlueBubblesError)
  return e as InstanceType<typeof BlueBubblesError>
}

describe('blueBubblesClient', () => {
  it('serverInfo reads private_api, server_version and detected_icloud', async () => {
    fake = await startFakeBlueBubbles({ privateApi: true })
    expect(await client().serverInfo()).toEqual({ privateApi: true, serverVersion: '1.9.9-fake', detectedIcloud: 'fake@icloud.com' })
  })

  it('sendText posts chatGuid/tempGuid/message and the apple-script method when the Private API is off', async () => {
    fake = await startFakeBlueBubbles({ privateApi: false })
    const r = await client().sendText(CHAT, 'hi there', 'd-1')
    expect(r).toEqual({ guid: fake.sent[0]!.guid, unconfirmed: false })
    expect(fake.sent).toMatchObject([{ kind: 'text', chatGuid: CHAT, tempGuid: 'd-1', message: 'hi there', method: 'apple-script' }])
  })

  it('sendText uses the private-api method when the server reports the Private API', async () => {
    fake = await startFakeBlueBubbles({ privateApi: true })
    await client().sendText(CHAT, 'hi', 'd-2')
    expect(fake.sent[0]!.method).toBe('private-api')
  })

  it('a 503 is a retryable BlueBubblesError', async () => {
    fake = await startFakeBlueBubbles({ failSends: 1 })
    const e = await rejection(client({ privateApi: false }).sendText(CHAT, 'x', 'd-3'))
    expect(e.retryable).toBe(true)
    expect(e.status).toBe(503)
    expect(fake.sent).toHaveLength(0)
  })

  it('a 401 (wrong password) is a non-retryable BlueBubblesError', async () => {
    fake = await startFakeBlueBubbles()
    const e = await rejection(blueBubblesClient({ serverUrl: fake.url, password: 'wrong', privateApi: false }).sendText(CHAT, 'x', 'd-4'))
    expect(e.retryable).toBe(false)
    expect(e.status).toBe(401)
  })

  it('a network error is retryable', async () => {
    fake = await startFakeBlueBubbles()
    const url = fake.url
    await fake.close()
    const e = await rejection(blueBubblesClient({ serverUrl: url, password: 'fake', privateApi: false }).sendText(CHAT, 'x', 'd-5'))
    expect(e.retryable).toBe(true)
  })

  it('a hung AppleScript send is unconfirmed, not an error', async () => {
    fake = await startFakeBlueBubbles({ sendHangs: true })
    const r = await client({ privateApi: false, timeoutMs: 150 }).sendText(CHAT, 'slow', 'd-6')
    expect(r).toEqual({ guid: null, unconfirmed: true })
  })

  it('a hung Private API send is a retryable error', async () => {
    fake = await startFakeBlueBubbles({ sendHangs: true })
    const e = await rejection(client({ privateApi: true, timeoutMs: 150 }).sendText(CHAT, 'slow', 'd-7'))
    expect(e.retryable).toBe(true)
  })

  it('findOwnMessage finds a pushed own message with the exact text since the cutoff', async () => {
    fake = await startFakeBlueBubbles()
    const now = Date.now()
    fake.pushMessage({ guid: 'old', text: 'ping', isFromMe: true, dateCreated: now - 60_000, chats: [{ guid: CHAT }] })
    fake.pushMessage({ guid: 'theirs', text: 'ping', isFromMe: false, dateCreated: now, chats: [{ guid: CHAT }] })
    fake.pushMessage({ guid: 'other-chat', text: 'ping', isFromMe: true, dateCreated: now, chats: [{ guid: 'iMessage;-;+15550000000' }] })
    fake.pushMessage({ guid: 'near', text: 'ping!', isFromMe: true, dateCreated: now, chats: [{ guid: CHAT }] })
    expect(await client().findOwnMessage(CHAT, 'ping', now - 1000)).toBeNull()
    fake.pushMessage({ guid: 'mine', text: 'ping', isFromMe: true, dateCreated: now, chats: [{ guid: CHAT }] })
    expect(await client().findOwnMessage(CHAT, 'ping', now - 1000)).toBe('mine')
  })

  it('messagesSince posts after/sort/limit/with and returns messages oldest first', async () => {
    fake = await startFakeBlueBubbles()
    fake.pushMessage({ guid: 'b', dateCreated: 3000 })
    fake.pushMessage({ guid: 'a', dateCreated: 2000 })
    fake.pushMessage({ guid: 'z', dateCreated: 500 })
    const got = await client().messagesSince(1000, 10)
    expect(fake.queries).toEqual([{ with: ['chat', 'attachment', 'handle'], after: 1000, sort: 'ASC', limit: 10 }])
    expect((got as { guid: string }[]).map(m => m.guid)).toEqual(['a', 'b'])
  })

  it('typing on/off hits POST/DELETE on the URL-encoded chat path; markRead POSTs read', async () => {
    fake = await startFakeBlueBubbles()
    const c = client()
    await c.typing(CHAT, true)
    await c.typing(CHAT, false)
    await c.markRead(CHAT)
    expect(fake.typing).toEqual([{ chatGuid: CHAT, on: true }, { chatGuid: CHAT, on: false }])
    expect(fake.reads).toEqual([CHAT])
  })

  it('react posts chatGuid, selectedMessageGuid and the tapback name', async () => {
    fake = await startFakeBlueBubbles()
    await client().react(CHAT, 'msg-1', 'love')
    expect(fake.reactions).toEqual([{ chatGuid: CHAT, selectedMessageGuid: 'msg-1', reaction: 'love' }])
  })

  it('URL-encodes the password (a password with & = / # still authenticates)', async () => {
    fake = await startFakeBlueBubbles({ password: 'p&ss=w/rd #1+' })
    expect((await client().serverInfo()).serverVersion).toBe('1.9.9-fake')
  })

  it('sendAttachment posts multipart with name, bytes type and tempGuid', async () => {
    fake = await startFakeBlueBubbles()
    const r = await client({ privateApi: false }).sendAttachment(CHAT, { name: 'pic.png', mime: 'image/png', data: Buffer.from([1, 2, 3]) }, 'd-8-img0')
    expect(r.unconfirmed).toBe(false)
    expect(fake.sent).toMatchObject([{ kind: 'attachment', chatGuid: CHAT, tempGuid: 'd-8-img0', name: 'pic.png', mime: 'image/png', size: 3, method: 'apple-script' }])
  })

  it('downloadAttachment asks for original=false and returns bytes, content-type and transferName', async () => {
    fake = await startFakeBlueBubbles()
    const fetchSpy = vi.fn(fetch)
    const a = await client({ fetchImpl: fetchSpy }).downloadAttachment('att-1')
    expect(a.mime).toBe('image/png')
    expect(a.name).toBe('photo.png')
    expect(a.data.subarray(1, 4).toString()).toBe('PNG')
    const dl = fetchSpy.mock.calls.map(c => new URL(String(c[0]))).find(u => u.pathname.endsWith('/download'))!
    expect(dl.searchParams.get('original')).toBe('false')
  })

  it('resolveDirectChat builds the DM guid from the normalised handle', async () => {
    fake = await startFakeBlueBubbles()
    expect(await client().resolveDirectChat('(555) 123-4567')).toBe(CHAT)
  })
})

describe('imessageClient', () => {
  it('BLUEBUBBLES_FAKE_URL overrides the config with password "fake"', async () => {
    fake = await startFakeBlueBubbles()
    process.env.BLUEBUBBLES_FAKE_URL = fake.url
    mocks.loadChannelsConfig.mockResolvedValue({ imessage: { enabled: false, serverUrl: 'https://real.invalid', passwordEnc: 'x' } })
    const c = await imessageClient()
    expect((await c!.serverInfo()).serverVersion).toBe('1.9.9-fake')
    expect(mocks.loadChannelsConfig).not.toHaveBeenCalled()
  })

  it('is null when iMessage is disabled or has no password', async () => {
    mocks.loadChannelsConfig.mockResolvedValue({ imessage: { enabled: false, serverUrl: 'http://x', passwordEnc: 'pw' } })
    expect(await imessageClient()).toBeNull()
    mocks.loadChannelsConfig.mockResolvedValue({ imessage: { enabled: true, serverUrl: 'http://x', passwordEnc: null } })
    expect(await imessageClient()).toBeNull()
  })
})

describe('imessageChannel.send', () => {
  const base = { id: 'del-1', target: CHAT, attempts: 0, firstClaimedAt: null }
  beforeEach(() => { mocks.getImageBytes.mockReset() })

  async function withFake(opts?: Parameters<typeof startFakeBlueBubbles>[0]) {
    fake = await startFakeBlueBubbles(opts)
    process.env.BLUEBUBBLES_FAKE_URL = fake.url
  }

  it('is not configured → non-retryable failure', async () => {
    mocks.loadChannelsConfig.mockResolvedValue({ imessage: { enabled: false, serverUrl: '', passwordEnc: null } })
    expect(await imessageChannel.send({ ...base, payload: { text: 'x' } }))
      .toEqual({ ok: false, error: 'iMessage is not configured', retryable: false })
  })

  it('sends the text (tempGuid = delivery id) then each image (tempGuid = id-img<i>)', async () => {
    await withFake()
    mocks.getImageBytes.mockResolvedValue({ bytes: Buffer.from([9, 9]), mime: 'image/jpeg' })
    const r = await imessageChannel.send({ ...base, payload: { text: 'look', images: ['img-a', 'img-b'] } })
    expect(r).toEqual({ ok: true, externalId: fake.sent[0]!.guid })
    expect(fake.sent.map(s => [s.kind, s.tempGuid, s.name ?? s.message])).toEqual([
      ['text', 'del-1', 'look'],
      ['attachment', 'del-1-img0', 'image-1.jpg'],
      ['attachment', 'del-1-img1', 'image-2.jpg']
    ])
    expect(mocks.getImageBytes.mock.calls.map(c => c[0])).toEqual(['img-a', 'img-b'])
  })

  it('a retry whose text is already in the chat is marked sent without sending again', async () => {
    await withFake()
    const claimed = new Date()
    fake.pushMessage({ guid: 'earlier', text: 'hello', isFromMe: true, dateCreated: claimed.getTime() + 1000, chats: [{ guid: CHAT }] })
    const r = await imessageChannel.send({ ...base, attempts: 1, firstClaimedAt: claimed, payload: { text: 'hello' } })
    expect(r).toEqual({ ok: true, externalId: 'earlier' })
    expect(fake.sent).toHaveLength(0)
  })

  it('a retry whose text is NOT in the chat sends', async () => {
    await withFake()
    const r = await imessageChannel.send({ ...base, attempts: 1, firstClaimedAt: new Date(), payload: { text: 'hello' } })
    expect(r.ok).toBe(true)
    expect(fake.sent).toHaveLength(1)
  })

  it('maps a 503 to a retryable failure', async () => {
    await withFake({ failSends: 1 })
    const r = await imessageChannel.send({ ...base, payload: { text: 'x' } })
    expect(r).toMatchObject({ ok: false, retryable: true })
  })

  it('isEnabled is true under BLUEBUBBLES_FAKE_URL, else follows the config', async () => {
    await withFake()
    expect(await imessageChannel.isEnabled()).toBe(true)
    delete process.env.BLUEBUBBLES_FAKE_URL
    mocks.loadChannelsConfig.mockResolvedValue({ imessage: { enabled: true, serverUrl: 'http://x', passwordEnc: null } })
    expect(await imessageChannel.isEnabled()).toBe(false)
  })
})

describe('channelFor', () => {
  it('imessage → the iMessage adapter; email → a placeholder that throws', async () => {
    expect(channelFor('imessage')).toBe(imessageChannel)
    await expect(channelFor('email').send({ ...{ id: 'x', target: 'a@b.c', attempts: 0, firstClaimedAt: null }, payload: { text: 'x' } }))
      .rejects.toThrow('not implemented')
  })
})
