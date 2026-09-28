// Cycle 75, Task 7: POST /api/channels/bluebubbles/webhook. The REAL token check runs
// (verifyWebhookToken over loadChannelsConfig) against a mocked settings read, so "wrong token",
// "missing token" and "channel disabled" are each exercised through the real code; the pipeline
// (handleInbound) is mocked. Also: the auth middleware lets the webhook path through untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import text from './fixtures/bluebubbles/text.json'
import updatedRead from './fixtures/bluebubbles/updated-read.json'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getQuery', (e: { query: Record<string, unknown> }) => e.query)
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const TOKEN = 'a'.repeat(64)
const state = vi.hoisted(() => ({ imessage: {} as Record<string, unknown> }))
const mocks = vi.hoisted(() => ({ handleInbound: vi.fn() }))

// The settings read loadChannelsConfig makes: select().from(settings).where(...) → rows.
vi.mock('../server/db', () => ({
  useDb: () => ({
    select: () => ({ from: () => ({ where: async () => [{ key: 'channel_imessage', value: state.imessage }] }) })
  })
}))
vi.mock('../server/lib/channels/inbound', () => ({ handleInbound: mocks.handleInbound }))

const { invalidateChannelsConfig } = await import('../server/lib/channels/config')
type H = (e: unknown) => Promise<unknown>
const handler = (await import('../server/api/channels/bluebubbles/webhook.post')).default as unknown as H

const evt = (query: Record<string, unknown>, body: unknown = text) => ({ query, body })

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  return p.then(() => 'ok' as const, (e: { statusCode?: number }) => e.statusCode ?? -1)
}

beforeEach(() => {
  mocks.handleInbound.mockReset()
  mocks.handleInbound.mockResolvedValue('enqueued')
  state.imessage = { enabled: true, serverUrl: 'http://bb.local', passwordEnc: null, webhookToken: TOKEN, allowedHandles: ['+15551234567'], defaultHandle: null, defaultChatGuid: null }
  invalidateChannelsConfig()
})

describe('BlueBubbles webhook route', () => {
  it('a wrong token is a 404 and nothing is handled', async () => {
    expect(await status(handler(evt({ token: 'b'.repeat(64) })))).toBe(404)
    expect(mocks.handleInbound).not.toHaveBeenCalled()
  })

  it('a missing token is a 404', async () => {
    expect(await status(handler(evt({})))).toBe(404)
    expect(mocks.handleInbound).not.toHaveBeenCalled()
  })

  it('a repeated ?token= (array) is a 404, never a match', async () => {
    expect(await status(handler(evt({ token: [TOKEN, TOKEN] })))).toBe(404)
  })

  it('the right token while iMessage is disabled is a 404', async () => {
    state.imessage = { ...state.imessage, enabled: false }
    expect(await status(handler(evt({ token: TOKEN })))).toBe(404)
    expect(mocks.handleInbound).not.toHaveBeenCalled()
  })

  it('the right token + a text payload hands the parsed message to handleInbound', async () => {
    const res = await handler(evt({ token: TOKEN }))
    expect(res).toEqual({ ok: true, outcome: 'enqueued' })
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1)
    expect(mocks.handleInbound.mock.calls[0]![0]).toMatchObject({ kind: 'message', guid: 'A1B2-TEXT', text: 'hey bridget' })
  })

  it('a payload with no event (a read-receipt update) answers ok without handling', async () => {
    expect(await handler(evt({ token: TOKEN }, updatedRead))).toEqual({ ok: true })
    expect(mocks.handleInbound).not.toHaveBeenCalled()
  })

  it('handleInbound throwing still answers 200 (ok: false), so BlueBubbles never retries into a loop', async () => {
    mocks.handleInbound.mockRejectedValue(new Error('db down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await handler(evt({ token: TOKEN }))).toEqual({ ok: false })
      expect(spy).toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})

describe('auth middleware', () => {
  it('lets the webhook path through without any credential check', async () => {
    const headers = vi.fn(() => { throw new Error('auth was consulted') })
    vi.stubGlobal('getRequestURL', (e: { url: string }) => new URL(e.url, 'http://x'))
    vi.stubGlobal('getHeader', headers)
    vi.stubGlobal('getCookie', headers)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    const mw = (await import('../server/middleware/auth')).default as unknown as (e: unknown) => Promise<unknown>
    expect(await mw({ url: '/api/channels/bluebubbles/webhook?token=x', context: {} })).toBeUndefined()
    expect(headers).not.toHaveBeenCalled()
    // A sibling path is NOT public: the middleware goes on to look for credentials.
    await mw({ url: '/api/channels/bluebubbles/webhookx', context: {} }).catch(() => {})
    expect(headers).toHaveBeenCalled()
  })
})
