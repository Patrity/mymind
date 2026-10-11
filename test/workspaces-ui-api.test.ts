// Cycle 82 Task 3: the Files / Shells / secret-toggle routes — auth (writes are session-only: an API
// token or OAuth client is refused before anything runs), path validation before the worker is asked
// (absolute paths, `..`, NUL → 400 and NO command), every read going to the WORKER (the web never
// opens a workspace file), the 100 MB download cap (413) and the chunked stream.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])
vi.stubGlobal('getQuery', (e: { query?: Record<string, unknown> }) => e.query ?? {})
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)
const headers: Record<string, unknown> = {}
vi.stubGlobal('setResponseHeaders', (_e: unknown, h: Record<string, unknown>) => { Object.assign(headers, h) })
vi.stubGlobal('sendStream', (_e: unknown, s: ReadableStream<Uint8Array>) => s)

const sendCommand = vi.fn()
vi.mock('@mymind/core/lib/bus/commands', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/bus/commands')>()), sendCommand: (...a: unknown[]) => sendCommand(...a) }))
const WS = '11111111-1111-4111-8111-111111111111'
const SHELL = '22222222-2222-4222-8222-222222222222'
const row = { id: WS, kind: 'workstream', workstreamId: null, state: 'running', tainted: false, taintedAt: null, bytesUsed: 0, inodesUsed: 0, lastUsedAt: new Date(0), deletedAt: null }
vi.mock('@mymind/core/db', () => ({ useDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) }) }))
const setSecretSandbox = vi.fn(async (_n: string, _s: boolean) => {})
vi.mock('@mymind/core/lib/exec/secrets', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/exec/secrets')>()), setSecretSandbox: (n: string, s: boolean) => setSecretSandbox(n, s) }))
const invalidate = vi.fn(async (_c: string) => {})
vi.mock('@mymind/core/lib/bus/invalidate', () => ({ invalidateWorkerCache: (c: string) => invalidate(c) }))

type H = (e: unknown) => Promise<unknown>
const load = async (p: string) => (await import(p)).default as H
const fileRoute = await load('../server/api/workspaces/[id]/file.get')
const downloadRoute = await load('../server/api/workspaces/[id]/download.get')
const filesRoute = await load('../server/api/workspaces/[id]/files.get')
const tailRoute = await load('../server/api/workspaces/[id]/shells/[shellId]/output.get')
const killRoute = await load('../server/api/workspaces/[id]/shells/[shellId]/kill.post')
const sandboxRoute = await load('../server/api/settings/exec-secrets/sandbox.put')
const { DOWNLOAD_MAX_BYTES, CHUNK_BYTES } = await import('@mymind/core/lib/sandbox/paths')

const ev = (type: string, o: { query?: Record<string, unknown>; body?: unknown; params?: Record<string, string> } = {}) =>
  ({ params: { id: WS, shellId: SHELL, ...o.params }, query: o.query, body: o.body, context: { client: { type } } })

beforeEach(() => { sendCommand.mockReset(); setSecretSandbox.mockClear(); invalidate.mockClear(); for (const k of Object.keys(headers)) delete headers[k] })

describe('writes are session-only (a bearer token is refused before anything runs)', () => {
  it('POST …/shells/:shellId/kill', async () => {
    for (const t of ['api-token', 'oauth', undefined]) await expect(killRoute(ev(t as string))).rejects.toMatchObject({ statusCode: 403 })
    expect(sendCommand).not.toHaveBeenCalled()
    sendCommand.mockResolvedValue({ shellId: SHELL, state: 'killed', alreadyEnded: false })
    expect(await killRoute(ev('session'))).toEqual({ shellId: SHELL, state: 'killed', alreadyEnded: false })
    expect(sendCommand).toHaveBeenCalledWith('workspace-kill-shell', { workspaceId: WS, shellId: SHELL }, expect.objectContaining({ awaitResult: true }))
  })
  it('PUT /api/settings/exec-secrets/sandbox', async () => {
    for (const t of ['api-token', 'oauth']) await expect(sandboxRoute(ev(t, { body: { name: 'GITHUB_TOKEN', sandbox: true } }))).rejects.toMatchObject({ statusCode: 403 })
    expect(setSecretSandbox).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(await sandboxRoute(ev('session', { body: { name: 'GITHUB_TOKEN', sandbox: true } }))).toEqual({ ok: true, name: 'GITHUB_TOKEN', sandbox: true })
    expect(setSecretSandbox).toHaveBeenCalledWith('GITHUB_TOKEN', true)
    expect(invalidate).toHaveBeenCalledWith('exec-secrets')
  })
  it('a reserved name (DOCKER_*, HOME, PATH, LANG) cannot be opted in; opting OUT is always allowed', async () => {
    for (const n of ['DOCKER_HOST', 'HOME', 'PATH', 'LANG', 'LD_PRELOAD']) {
      await expect(sandboxRoute(ev('session', { body: { name: n, sandbox: true } }))).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(setSecretSandbox).not.toHaveBeenCalled()
    await sandboxRoute(ev('session', { body: { name: 'DOCKER_HOST', sandbox: false } }))
    expect(setSecretSandbox).toHaveBeenCalledWith('DOCKER_HOST', false)
  })
})

describe('path validation happens before the worker is asked (and the read runs in the worker)', () => {
  const bad = ['/etc/passwd', '../x', 'a/../../b', 'a/..', '..', '\\\\host\\share', 'a\0b', '']
  it.each(bad)('file %j → 400, no command', async (path) => {
    await expect(fileRoute(ev('session', { query: { path } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it.each(bad)('download %j → 400, no command', async (path) => {
    await expect(downloadRoute(ev('session', { query: { path } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('a good path is read by the worker (workspace-view), never on this host', async () => {
    sendCommand.mockResolvedValue({ path: 'src/a.py', binary: false, bytes: 3, lines: 1, content: 'x=1' })
    expect(await fileRoute(ev('api-token', { query: { path: 'src/a.py' } }))).toMatchObject({ content: 'x=1' })
    expect(sendCommand).toHaveBeenCalledWith('workspace-view', { op: 'file', workspaceId: WS, path: 'src/a.py' }, expect.objectContaining({ awaitResult: true }))
  })
  it('tree and shell output also go to the worker', async () => {
    sendCommand.mockResolvedValue({ entries: [], count: 0, truncated: false })
    await filesRoute(ev('session'))
    expect(sendCommand).toHaveBeenLastCalledWith('workspace-view', { op: 'tree', workspaceId: WS }, expect.anything())
    sendCommand.mockResolvedValue({ shellId: SHELL, state: 'running', output: 'x' })
    await tailRoute(ev('session'))
    expect(sendCommand).toHaveBeenLastCalledWith('workspace-view', { op: 'shell-tail', workspaceId: WS, shellId: SHELL }, expect.anything())
  })
  it('a worker refusal (outside the workspace via a symlink) is a 400; not found 404', async () => {
    const { CommandFailedError } = await import('@mymind/core/lib/bus/commands')
    sendCommand.mockRejectedValue(new CommandFailedError('workspace-view', 1, 'the path leads outside the workspace'))
    await expect(fileRoute(ev('session', { query: { path: 'link' } }))).rejects.toMatchObject({ statusCode: 400 })
    sendCommand.mockRejectedValue(new CommandFailedError('workspace-view', 1, 'no such file'))
    await expect(fileRoute(ev('session', { query: { path: 'nope' } }))).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('download', () => {
  it('over 100 MB → 413, and nothing beyond the size probe is read', async () => {
    sendCommand.mockResolvedValue({ size: DOWNLOAD_MAX_BYTES + 1, mtimeNs: '1', data: '' })
    await expect(downloadRoute(ev('session', { query: { path: 'big.bin' } }))).rejects.toMatchObject({ statusCode: 413 })
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand.mock.calls[0]![1]).toMatchObject({ op: 'chunk', offset: 0, length: 0 })
  })
  it('exactly 100 MB is allowed', async () => {
    sendCommand.mockResolvedValue({ size: DOWNLOAD_MAX_BYTES, mtimeNs: '1', data: '' })
    await expect(downloadRoute(ev('session', { query: { path: 'ok.bin' } }))).resolves.toBeInstanceOf(ReadableStream)
  })
  it('streams the file in chunks read by the worker (rows discarded), as an attachment', async () => {
    const file = Buffer.alloc(CHUNK_BYTES + 10, 7)
    sendCommand.mockImplementation(async (_t: string, p: { offset: number; length: number }) =>
      ({ size: file.length, mtimeNs: '9', data: file.subarray(p.offset, p.offset + p.length).toString('base64') }))
    const s = await downloadRoute(ev('session', { query: { path: 'out/data.bin' } })) as ReadableStream<Uint8Array>
    const got = Buffer.from(await new Response(s).arrayBuffer())
    expect(got.equals(file)).toBe(true)
    expect(sendCommand.mock.calls.map(c => [c[1].offset, c[1].length])).toEqual([[0, 0], [0, CHUNK_BYTES], [CHUNK_BYTES, 10]])
    for (const c of sendCommand.mock.calls) expect(c[2]).toMatchObject({ discardResult: true })
    expect(headers).toMatchObject({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="data.bin"', 'content-length': file.length, 'x-content-type-options': 'nosniff' })
  })
  it('a file that changes mid-download fails the stream', async () => {
    let n = 0
    sendCommand.mockImplementation(async () => ({ size: CHUNK_BYTES * 2, mtimeNs: n++ === 0 ? '1' : '2', data: Buffer.alloc(10).toString('base64') }))
    const s = await downloadRoute(ev('session', { query: { path: 'f' } })) as ReadableStream<Uint8Array>
    await expect(new Response(s).arrayBuffer()).rejects.toThrow(/changed during the download/)
  })
})
