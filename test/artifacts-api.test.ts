// test/artifacts-api.test.ts — handler tests for /api/artifacts* (service mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, message?: string }) =>
  Object.assign(new Error(o.message ?? o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])
vi.stubGlobal('getQuery', (e: { query?: Record<string, unknown> }) => e.query ?? {})

class ArtifactError extends Error {
  override name = 'ArtifactError'
  constructor(message: string, readonly code: string) { super(message) }
}
vi.mock('@mymind/core/lib/artifacts/limits', () => ({ ArtifactError }))

const svc = {
  listArtifacts: vi.fn(),
  getArtifactDetail: vi.fn(),
  editArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  resolveArtifactRef: vi.fn()
}
vi.mock('@mymind/core/lib/artifacts/service', () => svc)
vi.mock('@mymind/core/lib/artifacts/token', () => ({ signViewToken: (id: string) => `tok-${id}` }))

const list = (await import('../server/api/artifacts/index.get')).default as (e: unknown) => Promise<unknown>
const get = (await import('../server/api/artifacts/[id].get')).default as (e: unknown) => Promise<unknown>
const patch = (await import('../server/api/artifacts/[id].patch')).default as (e: unknown) => Promise<unknown>
const del = (await import('../server/api/artifacts/[id].delete')).default as (e: unknown) => Promise<unknown>
const viewUrl = (await import('../server/api/artifacts/[id]/view-url.get')).default as (e: unknown) => Promise<unknown>

const session = { type: 'session' }
const ev = (extra: Record<string, unknown> = {}) => ({ params: { id: 'my-slug' }, context: { client: session }, ...extra })

beforeEach(() => {
  Object.values(svc).forEach(f => f.mockReset())
  svc.resolveArtifactRef.mockResolvedValue('art-1')
})

describe('artifacts API', () => {
  it('lists, passing the project filter', async () => {
    svc.listArtifacts.mockResolvedValue([{ id: 'a' }])
    await expect(list({ query: { project: 'p1' } })).resolves.toEqual([{ id: 'a' }])
    expect(svc.listArtifacts).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('GET resolves slug refs and 404s on unknown ref or missing detail', async () => {
    svc.getArtifactDetail.mockResolvedValue({ id: 'art-1' })
    await expect(get(ev())).resolves.toEqual({ id: 'art-1' })
    expect(svc.resolveArtifactRef).toHaveBeenCalledWith('my-slug')
    svc.resolveArtifactRef.mockResolvedValue(null)
    await expect(get(ev())).rejects.toMatchObject({ statusCode: 404 })
    svc.resolveArtifactRef.mockResolvedValue('art-1')
    svc.getArtifactDetail.mockResolvedValue(null)
    await expect(get(ev())).rejects.toMatchObject({ statusCode: 404 })
  })

  it('PATCH validates the body (isPublic: "yes" -> 400) without calling the service', async () => {
    await expect(patch(ev({ body: { isPublic: 'yes' } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(svc.editArtifact).not.toHaveBeenCalled()
  })

  it('PATCH edits and returns the DTO; 404 when gone', async () => {
    svc.editArtifact.mockResolvedValue({ id: 'art-1', title: 'T' })
    await expect(patch(ev({ body: { title: 'T', rollbackTo: 2 } }))).resolves.toEqual({ id: 'art-1', title: 'T' })
    expect(svc.editArtifact).toHaveBeenCalledWith('art-1', { title: 'T', rollbackTo: 2 })
    svc.editArtifact.mockResolvedValue(null)
    await expect(patch(ev({ body: { title: 'T' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('PATCH maps ArtifactError to 400 with its message', async () => {
    svc.editArtifact.mockRejectedValue(new ArtifactError('slug x is already in use', 'bad_slug'))
    await expect(patch(ev({ body: { slug: 'x' } }))).rejects.toMatchObject({ statusCode: 400, message: 'slug x is already in use' })
  })

  it('PATCH lets non-artifact errors through', async () => {
    svc.editArtifact.mockRejectedValue(new Error('db down'))
    await expect(patch(ev({ body: { title: 'T' } }))).rejects.toThrow('db down')
  })

  it('DELETE returns ok; 404 for unknown', async () => {
    svc.deleteArtifact.mockResolvedValue(true)
    await expect(del(ev())).resolves.toEqual({ ok: true })
    svc.deleteArtifact.mockResolvedValue(false)
    await expect(del(ev())).rejects.toMatchObject({ statusCode: 404 })
  })

  it('view-url: public is a plain relative url, private carries a token', async () => {
    svc.getArtifactDetail.mockResolvedValue({ id: 'art-1', slug: 'pub', isPublic: true })
    await expect(viewUrl(ev())).resolves.toEqual({ url: '/artifact/pub/' })
    svc.getArtifactDetail.mockResolvedValue({ id: 'art-1', slug: 'priv', isPublic: false })
    await expect(viewUrl(ev())).resolves.toEqual({ url: '/artifact/priv/~tok-art-1/' })
  })

  it('view-url refuses an api-token client and 404s on unknown', async () => {
    await expect(viewUrl(ev({ context: { client: { type: 'api-token' } } }))).rejects.toMatchObject({ statusCode: 403 })
    svc.resolveArtifactRef.mockResolvedValue(null)
    await expect(viewUrl(ev())).rejects.toMatchObject({ statusCode: 404 })
  })
})
