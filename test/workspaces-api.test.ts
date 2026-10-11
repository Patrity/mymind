// Cycle 82: POST /api/workspaces/:id/reenable-network — session-only, and the WORKER does it
// (kills the workspace's tainted runs first; lib/sandbox/manager.ts reenableNetwork, proven against
// real Docker in test/sandbox.db.test.ts). Here: auth, validation, and the command round trip.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])

const sendCommand = vi.fn()
vi.mock('@mymind/core/lib/bus/commands', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/bus/commands')>()), sendCommand: (...a: unknown[]) => sendCommand(...a) }))
const { CommandFailedError, CommandTimeoutError } = await import('@mymind/core/lib/bus/commands')
const handler = (await import('../server/api/workspaces/[id]/reenable-network.post')).default as unknown as (e: unknown) => Promise<unknown>

const ID = '11111111-1111-4111-8111-111111111111'
const ev = (type: string, id = ID) => ({ params: { id }, context: { client: { type } } })

beforeEach(() => { sendCommand.mockReset() })

describe('POST /api/workspaces/:id/reenable-network', () => {
  it('refuses anything but a web session (API token, OAuth/MCP) and never reaches the worker', async () => {
    for (const t of ['api-token', 'oauth']) await expect(handler(ev(t))).rejects.toMatchObject({ statusCode: 403 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('404 for a malformed id', async () => {
    await expect(handler(ev('session', '../etc'))).rejects.toMatchObject({ statusCode: 404 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('asks the worker and waits for its answer', async () => {
    sendCommand.mockResolvedValue({ id: ID, tainted: false })
    expect(await handler(ev('session'))).toEqual({ id: ID, tainted: false })
    expect(sendCommand).toHaveBeenCalledWith('workspace-reenable-network', { workspaceId: ID }, { awaitResult: true })
  })
  it('a dead worker is a 504 (the flag stays set); a refusal is a 409; unknown is 404', async () => {
    sendCommand.mockRejectedValue(new CommandTimeoutError('workspace-reenable-network', 1, 10_000))
    await expect(handler(ev('session'))).rejects.toMatchObject({ statusCode: 504 })
    sendCommand.mockRejectedValue(new CommandFailedError('workspace-reenable-network', 1, 'could not stop 1 tainted command(s)'))
    await expect(handler(ev('session'))).rejects.toMatchObject({ statusCode: 409 })
    sendCommand.mockRejectedValue(new CommandFailedError('workspace-reenable-network', 1, `workspace ${ID} not found`))
    await expect(handler(ev('session'))).rejects.toMatchObject({ statusCode: 404 })
  })
})
