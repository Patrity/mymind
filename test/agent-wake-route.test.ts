// test/agent-wake-route.test.ts
//
// POST /api/admin/agent/wake. Every /api/admin/** route sits behind the shared auth middleware
// (server/middleware/auth.ts), but that middleware also accepts a bearer API token — a leaked
// machine token must not be able to start an unattended background run on its own, so this
// endpoint additionally requires a real web SESSION (requireSession). Follows the stubGlobal +
// dynamic-import pattern from test/conversation-leaf-route.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const wake = vi.fn()
vi.mock('../server/lib/agent/runtime/wake', () => ({ wake }))

// requireSession itself is NOT mocked — it's a pure predicate over event.context.client
// (server/utils/auth-guard.ts) with no I/O, so exercising the real thing is what actually
// proves the endpoint is wired to it.
const { RuntimeDisabledError } = await import('../server/lib/agent/runtime/flag')
const handler = (await import('../server/api/admin/agent/wake.post')).default as (e: unknown) => Promise<unknown>
const evt = (client: { type?: string } | undefined, body: unknown = {}) => ({ context: { client }, body })

beforeEach(() => { wake.mockReset() })

describe('POST /api/admin/agent/wake', () => {
  it('rejects a bearer-token-only (api-token) client', async () => {
    await expect(handler(evt({ type: 'api-token', tokenId: 't1' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(wake).not.toHaveBeenCalled()
  })

  it('rejects a request with no client context at all', async () => {
    await expect(handler(evt(undefined))).rejects.toMatchObject({ statusCode: 403 })
    expect(wake).not.toHaveBeenCalled()
  })

  it('lets an authenticated session through to wake()', async () => {
    wake.mockResolvedValue({ runId: 'r1', conversationId: 'c1' })
    const out = await handler(evt({ type: 'session', userId: 'u1' }, { reason: 'manual', prompt: 'hi' }))
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ reason: 'manual', prompt: 'hi' }))
    expect(out).toEqual({ runId: 'r1', conversationId: 'c1' })
  })

  it('maps a validation error from wake() to 400, not 500', async () => {
    wake.mockRejectedValue(new Error('wake: prompt is required'))
    await expect(handler(evt({ type: 'session', userId: 'u1' }, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('maps a not-found error (bad thread sessionKey) to 400 too', async () => {
    wake.mockRejectedValue(new Error('conversation deadbeef not found'))
    await expect(handler(evt({ type: 'session', userId: 'u1' }, { reason: 'x', prompt: 'y' }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('maps a disabled runtime (agent_runtime=false) to 409', async () => {
    wake.mockRejectedValue(new RuntimeDisabledError())
    await expect(handler(evt({ type: 'session', userId: 'u1' }, { reason: 'x', prompt: 'y' }))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('lets an unexpected error propagate UNMODIFIED rather than laundering it into a 400', async () => {
    const boom = new Error('db exploded')
    wake.mockRejectedValue(boom)
    await expect(handler(evt({ type: 'session', userId: 'u1' }, { reason: 'x', prompt: 'y' }))).rejects.toBe(boom)
  })

  it('defaults a null/empty body to {}', async () => {
    wake.mockResolvedValue({ runId: 'r2', conversationId: 'c2' })
    await handler({ context: { client: { type: 'session', userId: 'u1' } }, body: null })
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ reason: 'admin', prompt: '' }))
  })
})
