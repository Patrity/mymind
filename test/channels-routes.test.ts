// Cycle 75, Task 3 (fix round 1): the channel settings + presence routes are web-SESSION only.
// server/middleware/auth.ts also admits bearer API tokens / OAuth, so each handler calls
// requireSession (real, not mocked — it's a pure predicate over event.context.client). Also covers
// the PUT's 422 (bad shape) / 400 (bad default handle) mapping. Config I/O is mocked; the pure
// schema + merge are real. Pattern: test/agent-wake-route.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('setResponseStatus', (e: { status?: number }, code: number) => { e.status = code })

const cfg = {
  imessage: { enabled: false, serverUrl: '', passwordEnc: null, webhookToken: 't'.repeat(64), allowedHandles: ['+15551234567'], defaultHandle: '+15551234567', defaultChatGuid: null },
  email: { enabled: false, to: null },
  presenceAwayMinutes: 10
}
const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), rotate: vi.fn(), dto: vi.fn(), markActive: vi.fn()
}))
vi.mock('../server/lib/channels/config', async (orig) => {
  const actual = await orig<typeof import('../server/lib/channels/config')>()
  return {
    ...actual,
    loadChannelsConfig: mocks.load,
    saveChannelsConfig: mocks.save,
    rotateWebhookToken: mocks.rotate,
    invalidateChannelsConfig: vi.fn(),
    channelsConfigDTO: mocks.dto
  }
})
vi.mock('../server/lib/channels/presence', () => ({ markActive: mocks.markActive }))

type H = (e: unknown) => Promise<unknown> | unknown
const get = (await import('../server/api/settings/channels.get')).default as H
const put = (await import('../server/api/settings/channels.put')).default as H
const regen = (await import('../server/api/settings/channels/regenerate-token.post')).default as H
const presence = (await import('../server/api/presence.post')).default as H

const evt = (client: { type?: string } | undefined, body: unknown = {}) => ({ context: { client }, body }) as { context: unknown, body: unknown, status?: number }
const session = { type: 'session', userId: 'u1' }
const goodBody = {
  imessage: { enabled: true, serverUrl: 'http://bb.local:1234', password: { keep: true }, allowedHandles: ['+15551234567'], defaultHandle: '+15551234567' },
  email: { enabled: false, to: null },
  presenceAwayMinutes: 10
}

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset())
  mocks.load.mockResolvedValue(cfg)
  mocks.dto.mockResolvedValue({ ok: 'dto' })
})

describe.each([
  ['GET /api/settings/channels', () => get],
  ['PUT /api/settings/channels', () => put],
  ['POST /api/settings/channels/regenerate-token', () => regen],
  ['POST /api/presence', () => presence]
])('%s requires a web session', (_name, h) => {
  it('rejects an api-token client with 403', async () => {
    await expect((async () => h()(evt({ type: 'api-token', tokenId: 't1' }, goodBody)))()).rejects.toMatchObject({ statusCode: 403 })
  })
  it('rejects an oauth client with 403', async () => {
    await expect((async () => h()(evt({ type: 'oauth', tokenId: 't2' }, goodBody)))()).rejects.toMatchObject({ statusCode: 403 })
  })
  it('rejects an anonymous request (no client context) with 403', async () => {
    await expect((async () => h()(evt(undefined, goodBody)))()).rejects.toMatchObject({ statusCode: 403 })
  })
  it('touches nothing when rejected', async () => {
    await (async () => h()(evt({ type: 'api-token' }, goodBody)))().catch(() => {})
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.rotate).not.toHaveBeenCalled()
    expect(mocks.markActive).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
})

describe('session callers', () => {
  it('GET returns the DTO', async () => {
    expect(await get(evt(session))).toEqual({ ok: 'dto' })
  })
  it('PUT with a bad shape → 422, nothing saved', async () => {
    await expect(put(evt(session, { imessage: { enabled: 'yes' } }))).rejects.toMatchObject({ statusCode: 422 })
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('PUT with a non-http(s) serverUrl → 422', async () => {
    await expect(put(evt(session, { ...goodBody, imessage: { ...goodBody.imessage, serverUrl: 'javascript:alert(1)' } }))).rejects.toMatchObject({ statusCode: 422 })
  })
  it('PUT with a defaultHandle outside the allowlist → 400, nothing saved', async () => {
    await expect(put(evt(session, { ...goodBody, imessage: { ...goodBody.imessage, defaultHandle: '+15559999999' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('PUT valid → saves the merged config and returns the DTO', async () => {
    expect(await put(evt(session, goodBody))).toEqual({ ok: 'dto' })
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ imessage: expect.objectContaining({ enabled: true, serverUrl: 'http://bb.local:1234' }) }))
  })
  it('regenerate rotates the token and returns the DTO', async () => {
    expect(await regen(evt(session))).toEqual({ ok: 'dto' })
    expect(mocks.rotate).toHaveBeenCalledOnce()
  })
  it('presence marks active and returns 204', async () => {
    const e = evt(session)
    await presence(e)
    expect(mocks.markActive).toHaveBeenCalledOnce()
    expect(e.status).toBe(204)
  })
})
