import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock h3 functions FIRST, before importing anything that uses h3
vi.mock('h3', async () => {
  const actual = await vi.importActual('h3')
  return {
    ...actual,
    getQuery: vi.fn((event) => {
      // Parse query from the event.node.req.url
      const url = new URL(event.node.req.url || '/?', 'http://localhost')
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        query[key] = value
      })
      return query
    }),
    getRouterParam: vi.fn((event, key) => {
      return event.context?.params?.[key]
    }),
    createError: vi.fn((opts) => {
      const error = new Error(opts.statusMessage)
      ;(error as any).statusCode = opts.statusCode
      return error
    })
  }
})

const getSessionMessagesPage = vi.fn()
const getSessionMessages = vi.fn()
vi.mock('../server/services/sessions', () => ({ getSessionMessagesPage, getSessionMessages }))

// Define Nitro globals for testing
globalThis.defineEventHandler = (fn: any) => fn
globalThis.createError = (opts: any) => {
  const error = new Error(opts.statusMessage)
  ;(error as any).statusCode = opts.statusCode
  return error
}
globalThis.getQuery = (event: any) => {
  // Parse query from the event.node.req.url
  const url = new URL(event.node.req.url || '/?', 'http://localhost')
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  return query
}
globalThis.getRouterParam = (event: any, key: string) => {
  return event.context?.params?.[key]
}

const handler = (await import('../server/api/sessions/[id]/messages.get')).default

/** Minimal H3-ish event: the handler only reads the route param and the query. */
function evt(query: Record<string, string>) {
  return { context: { params: { id: 'sess-1' } }, node: { req: { url: `/?${new URLSearchParams(query)}` } } } as never
}

beforeEach(() => { getSessionMessagesPage.mockReset(); getSessionMessages.mockReset() })

describe('GET /api/sessions/:id/messages', () => {
  it('rejects before + since together instead of guessing', async () => {
    await expect(handler(evt({ before: 'abc', since: '2026-01-01' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(getSessionMessagesPage).not.toHaveBeenCalled()
    expect(getSessionMessages).not.toHaveBeenCalled()
  })

  it('routes since to the delta path', async () => {
    getSessionMessages.mockResolvedValue({ messages: [], toolEvents: [] })
    await handler(evt({ since: '2026-01-01T00:00:00.000Z' }))
    expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { since: '2026-01-01T00:00:00.000Z' })
  })

  it('passes filters through, coercing hideSidechain to a boolean', async () => {
    getSessionMessagesPage.mockResolvedValue({ messages: [], toolEvents: [], nextCursor: null })
    await handler(evt({ limit: '50', hideSidechain: 'true', tool: 'Bash', q: 'error' }))
    expect(getSessionMessagesPage).toHaveBeenCalledWith('sess-1',
      { before: undefined, limit: 50, hideSidechain: true, tool: 'Bash', q: 'error' })
  })

  it('treats a non-numeric limit as absent rather than NaN', async () => {
    getSessionMessagesPage.mockResolvedValue({ messages: [], toolEvents: [], nextCursor: null })
    await handler(evt({ limit: 'abc' }))
    expect(getSessionMessagesPage.mock.calls[0]![1].limit).toBeUndefined()
  })
})
