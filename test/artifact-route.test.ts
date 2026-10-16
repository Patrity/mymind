// Cycle 86 Task 5 — /artifact/** serving route. Drives the real handler through a real h3 app on an
// ephemeral port (so redirects, HEAD, 304 and streaming behave as in Nitro); only findServable,
// storage and useAuth are mocked. All decision logic is unit-tested in artifact-serve.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import type * as H3 from 'h3'
import { ARTIFACT_CSP } from '@mymind/core/lib/artifacts/serve'
import { signViewToken } from '@mymind/core/lib/artifacts/token'

// h3 is nitro's transitive dep (not a direct one): resolve the copy Nuxt's Nitro actually runs.
const req0 = createRequire(import.meta.url)
const nitroReq = createRequire(req0.resolve('nitropack/package.json', { paths: [req0.resolve('nuxt/package.json')] }))
const h3 = (await import(nitroReq.resolve('h3'))) as typeof H3

for (const k of ['defineEventHandler', 'getRequestURL', 'setResponseHeaders', 'setResponseHeader', 'setResponseStatus', 'getHeader', 'sendRedirect', 'sendStream'] as const) {
  vi.stubGlobal(k, (h3 as unknown as Record<string, unknown>)[k])
}
vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-artifact-route')
vi.stubGlobal('useRuntimeConfig', () => ({ betterAuthSecret: 'test-secret-for-artifact-route' }))

const getSession = vi.fn()
vi.stubGlobal('useAuth', () => ({ api: { getSession } }))

const findServable = vi.fn()
vi.mock('@mymind/core/lib/artifacts/service', () => ({ findServable }))
const get = vi.fn()
vi.mock('@mymind/core/utils/storage', () => ({ storage: () => ({ get }) }))

const file = { key: 'k1', sha256: 'abc123', size: 11, contentType: 'text/html; charset=utf-8' }
const servable = (isPublic: boolean) => ({
  artifactId: 'art-1', slug: 'demo', isPublic, entry: 'index.html', spaFallback: false,
  manifest: { 'index.html': file, 'app.js': { ...file, key: 'k2', sha256: 'def456', contentType: 'text/javascript; charset=utf-8' } }
})

let server: Server
let base: string
beforeAll(async () => {
  const handler = (await import('../server/routes/artifact/[...rest]')).default
  const app = h3.createApp()
  app.use(handler as H3.EventHandler)
  server = createServer(h3.toNodeListener(app))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })
beforeEach(() => {
  findServable.mockReset(); get.mockReset(); getSession.mockReset()
  findServable.mockImplementation(async (slug: string) => slug === 'demo' ? servable(false) : null)
  get.mockImplementation(async () => ({ stream: Readable.from([Buffer.from('hello world')]) }))
  getSession.mockResolvedValue(null)
})

const req = (path: string, init: RequestInit & { dest?: string } = {}) => {
  const { dest, ...rest } = init
  return fetch(base + path, { redirect: 'manual', ...rest, headers: { ...(dest ? { 'sec-fetch-dest': dest } : {}), ...(rest.headers as Record<string, string>) } })
}
const csp = (r: Response) => expect(r.headers.get('content-security-policy')).toBe(ARTIFACT_CSP)

describe('/artifact/** route', () => {
  it('serves a public artifact with CSP and public cache', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo/')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello world')
    csp(r)
    expect(r.headers.get('cache-control')).toBe('public, max-age=60')
    expect(r.headers.get('etag')).toBe('"abc123"')
  })

  it('301s a slash-less URL to the slash form, with CSP', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo')
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/artifact/demo/')
    csp(r)
  })

  it('404s an unknown slug on a subresource, and on a navigation with a session, with CSP', async () => {
    const r = await req('/artifact/nope/', { dest: 'script' })
    expect(r.status).toBe(404)
    csp(r)
    getSession.mockResolvedValue({ user: { id: 'u1' } })
    const n = await req('/artifact/nope/', { dest: 'document' })
    expect(n.status).toBe(404)
    csp(n)
  })

  it('an unknown slug on a navigation with no session answers like a private one (login redirect)', async () => {
    const unknown = await req('/artifact/nope/', { dest: 'document' })
    const priv = await req('/artifact/demo/', { dest: 'document' })
    expect(unknown.status).toBe(302)
    expect(unknown.headers.get('location')).toBe('/login?redirect=%2Fartifact%2Fnope%2F')
    expect(priv.headers.get('location')).toBe('/login?redirect=%2Fartifact%2Fdemo%2F')
    expect(unknown.headers.get('cache-control')).toBe(priv.headers.get('cache-control'))
    csp(unknown)
  })

  it('private + no session + document navigation -> 302 to login with redirect', async () => {
    const r = await req('/artifact/demo/', { dest: 'document' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/login?redirect=%2Fartifact%2Fdemo%2F')
    csp(r)
  })

  it('private + session -> 302 to a tokenised URL that then serves subresources without a session', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } })
    const r = await req('/artifact/demo/', { dest: 'document' })
    expect(r.status).toBe(302)
    const loc = r.headers.get('location')!
    expect(loc).toMatch(/^\/artifact\/demo\/~[^/]+\/$/)
    csp(r)

    getSession.mockResolvedValue(null)
    const sub = await req(loc + 'app.js', { dest: 'script' })
    expect(sub.status).toBe(200)
    expect(sub.headers.get('cache-control')).toBe('private, no-store')
    csp(sub)
  })

  it('private + no session + script request + no token -> 404 identical to a missing artifact', async () => {
    const missing = await req('/artifact/nope/app.js', { dest: 'script' })
    const r = await req('/artifact/demo/app.js', { dest: 'script' })
    expect(r.status).toBe(404)
    expect(await r.text()).toBe(await missing.text())
    csp(r)
  })

  it('private + bad token on a subresource -> 403 with CSP', async () => {
    const r = await req('/artifact/demo/~garbage/app.js', { dest: 'script' })
    expect(r.status).toBe(403)
    csp(r)
  })

  it('404s other methods (POST) with CSP', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo/', { method: 'POST' })
    expect(r.status).toBe(404)
    csp(r)
  })

  it('answers an OPTIONS preflight with 204, CORS and CSP', async () => {
    const r = await req('/artifact/demo/data/x.json', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'GET' } })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-methods')).toBe('GET, HEAD')
    expect(r.headers.get('access-control-allow-headers')).toBe('*')
    expect(r.headers.get('access-control-max-age')).toBe('600')
    expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    csp(r)
  })

  it('GET responses carry access-control-allow-origin *', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo/', { headers: { origin: 'null' } })
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('HEAD returns headers and no body, without touching storage', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo/', { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('')
    expect(get).not.toHaveBeenCalled()
    csp(r)
  })

  it('304s on a matching if-none-match, with CSP', async () => {
    findServable.mockResolvedValue(servable(true))
    const r = await req('/artifact/demo/', { headers: { 'if-none-match': '"abc123"' } })
    expect(r.status).toBe(304)
    expect(get).not.toHaveBeenCalled()
    csp(r)
  })

  it('403s a valid token minted for a DIFFERENT artifact', async () => {
    const tok = signViewToken('other-artifact')
    const r = await req(`/artifact/demo/~${tok}/app.js`, { dest: 'script' })
    expect(r.status).toBe(403)
    expect(r.headers.get('content-type')).toContain('text/plain')
    csp(r)
  })

  it('500s (CSP, no etag, not public) when the blob is missing', async () => {
    findServable.mockResolvedValue(servable(true))
    get.mockRejectedValue(new Error('Not found: k1'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await req('/artifact/demo/')
      expect(r.status).toBe(500)
      expect(await r.text()).toBe('Internal Server Error')
      csp(r)
      expect(r.headers.get('etag')).toBeNull()
      expect(r.headers.get('cache-control')).not.toContain('public')
    } finally { spy.mockRestore() }
  })

  it('answers a bare 500 (with CSP, no detail) when the signing secret is unreadable', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '')
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await req('/artifact/demo/~sometoken/app.js', { dest: 'script' })
      expect(r.status).toBe(500)
      expect(await r.text()).toBe('Internal Server Error')
      csp(r)
    } finally {
      spy.mockRestore()
      vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-artifact-route')
      vi.stubGlobal('useRuntimeConfig', () => ({ betterAuthSecret: 'test-secret-for-artifact-route' }))
    }
  })
})
