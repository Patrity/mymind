// Cycle 86 (option C): POST /api/workspaces/:id/trust — session-only; it clears the workspace's taint
// flag through markWorkspaceTrusted (proven on real rows in test/workspace-tools.db.test.ts). Here:
// auth, the lookup, and the DTO round trip.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))

const ID = '11111111-1111-4111-8111-111111111111'
const row = (tainted: boolean) => ({ id: ID, kind: 'home', workstreamId: null, state: 'stopped', tainted, taintedAt: tainted ? new Date(0) : null, bytesUsed: 0, inodesUsed: 0, lastUsedAt: new Date(0), createdAt: new Date(0), deletedAt: null, containerId: null })
const markWorkspaceTrusted = vi.fn()
const requireWorkspace = vi.fn()
vi.mock('@mymind/core/lib/sandbox/store', () => ({ markWorkspaceTrusted: (...a: unknown[]) => markWorkspaceTrusted(...a) }))
vi.mock('../server/utils/workspaces-http', () => ({
  requireWorkspace: (...a: unknown[]) => requireWorkspace(...a),
  toWorkspaceDTO: (r: { id: string; tainted: boolean; taintedAt: Date | null }) => ({ id: r.id, tainted: r.tainted, taintedAt: r.taintedAt?.toISOString() ?? null })
}))
const handler = (await import('../server/api/workspaces/[id]/trust.post')).default as unknown as (e: unknown) => Promise<unknown>
const ev = (type: string) => ({ params: { id: ID }, context: { client: { type } } })

beforeEach(() => {
  markWorkspaceTrusted.mockReset(); requireWorkspace.mockReset()
  requireWorkspace.mockResolvedValue(row(true))
})

describe('POST /api/workspaces/:id/trust', () => {
  it('refuses a bearer API token and OAuth/MCP (403) — nothing is looked up or cleared', async () => {
    for (const t of ['api-token', 'oauth']) await expect(handler(ev(t))).rejects.toMatchObject({ statusCode: 403 })
    await expect(handler({ params: { id: ID }, context: {} })).rejects.toMatchObject({ statusCode: 403 })
    expect(requireWorkspace).not.toHaveBeenCalled()
    expect(markWorkspaceTrusted).not.toHaveBeenCalled()
  })
  it('a web session clears the flag of the resolved workspace and gets the updated DTO', async () => {
    markWorkspaceTrusted.mockResolvedValue(row(false))
    expect(await handler(ev('session'))).toEqual({ id: ID, tainted: false, taintedAt: null })
    expect(markWorkspaceTrusted).toHaveBeenCalledWith(ID)
  })
  it('404 when the workspace is gone by the time it is cleared', async () => {
    markWorkspaceTrusted.mockResolvedValue(null)
    await expect(handler(ev('session'))).rejects.toMatchObject({ statusCode: 404 })
  })
})
