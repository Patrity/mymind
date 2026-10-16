import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  publishArtifact: vi.fn(), editArtifact: vi.fn(), setCurrentVersion: vi.fn(), listArtifacts: vi.fn(),
  getArtifactDetail: vi.fn(), resolveArtifactRef: vi.fn(), deleteArtifact: vi.fn(), restoreArtifact: vi.fn()
}))
const bundle = vi.hoisted(() => ({ readWorkspaceBundle: vi.fn() }))
const run = vi.hoisted(() => ({ conversationId: 'conv-1' as string | null, resolve: vi.fn() }))
vi.mock('../../artifacts/service', () => svc)
vi.mock('../../artifacts/workspace-bundle', () => bundle)
vi.mock('../../sandbox/runtime', async (orig) => ({ ...(await orig<object>()), workspaceRuntime: () => ({ resolve: run.resolve }) }))
vi.mock('../../../db', () => ({
  useDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => (run.conversationId ? [{ c: run.conversationId }] : []) }) }) }) })
}))
const store = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../sandbox/store', () => ({ dbWorkspaceStore: store }))
vi.mock('../../../services/projects', () => ({ getProject: async (s: string) => (s === 'mymind' ? { id: 'proj-1' } : null) }))

import { artifactTools, artifactDangerousTools, publishArtifactTool, editArtifactTool, deleteArtifactTool } from './artifacts'
import { ArtifactError } from '../../artifacts/limits'
import { TOOLSETS } from '../toolsets'
import { toolByName } from '../tools'
import type { ToolContext, ApprovalRequest } from '../types'
import { buildAiTools } from '../ai-tools'
import { z } from 'zod'

const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ signal: new AbortController().signal, runId: 'run-1', ...o })
const art = { id: 'a1', slug: 'dash', title: 'Dash', url: 'https://x/artifact/dash/', isPublic: false, currentVersion: 1 }
const published = (o: object = {}) => ({ artifact: art, version: 1, created: true, newVersion: true, previousVersionId: null, ...o })

beforeEach(() => {
  vi.resetAllMocks()
  run.conversationId = 'conv-1'
  run.resolve.mockResolvedValue({ workspaceId: 'ws-1' })
  svc.publishArtifact.mockResolvedValue(published())
})

describe('publish_artifact', () => {
  it('publishes html as index.html, private by default, stamped with the run\'s conversation', async () => {
    const ex = await publishArtifactTool.handler({ title: 'Dash', html: '<p>hi</p>' }, ctx())
    const input = svc.publishArtifact.mock.calls[0]![0]
    expect(input.files).toEqual([{ path: 'index.html', content: '<p>hi</p>' }])
    expect(input.isPublic).toBeUndefined()
    expect(input.conversationId).toBe('conv-1')
    expect(ex.result).toMatchObject({ ok: true, id: 'a1', slug: 'dash', url: 'https://x/artifact/dash/', version: 1, created: true, newVersion: true, warnings: [] })
    expect(ex.summary).toBe('published "Dash" v1 → /artifact/dash/')
  })

  it('treats files:{} as absent next to workspace_path', async () => {
    bundle.readWorkspaceBundle.mockResolvedValue({ files: [{ path: 'index.html', content: 'x' }], masked: 0, skipped: [] })
    const ex = await publishArtifactTool.handler({ title: 'D', files: {}, workspace_path: 'dist' }, ctx())
    expect(ex.result).toMatchObject({ ok: true })
    expect(bundle.readWorkspaceBundle).toHaveBeenCalled()
  })

  it('refuses a publish with nothing in it, without calling the service', async () => {
    for (const args of [{ files: {}, merge: true, slug: 'dash' }, { title: 'D', files: {} }]) {
      const ex = await publishArtifactTool.handler(args, ctx())
      expect(ex.result).toEqual({ ok: false, error: 'nothing to publish — pass html, files with at least one entry, or workspace_path' })
    }
    expect(svc.publishArtifact).not.toHaveBeenCalled()
  })

  it('has a null conversation when there is no run (MCP)', async () => {
    await publishArtifactTool.handler({ title: 'Dash', html: 'x' }, ctx({ runId: undefined }))
    expect(svc.publishArtifact.mock.calls[0]![0].conversationId).toBeNull()
  })

  it('resolves the project slug; an unknown one is ok:false', async () => {
    await publishArtifactTool.handler({ title: 'D', html: 'x', project: 'mymind' }, ctx())
    expect(svc.publishArtifact.mock.calls[0]![0].projectId).toBe('proj-1')
    svc.publishArtifact.mockClear()
    const ex = await publishArtifactTool.handler({ title: 'D', html: 'x', project: 'nope' }, ctx())
    expect(ex.result).toMatchObject({ ok: false, error: expect.stringContaining('unknown project') })
    expect(svc.publishArtifact).not.toHaveBeenCalled()
  })

  it.each([
    [{ html: 'x', files: { 'a.txt': 'b' } }],
    [{ html: 'x', workspace_path: 'dist' }],
    [{ files: { 'a.txt': 'b' }, workspace_path: 'dist' }],
    [{}]
  ])('rejects %j: exactly one source is required', async (args) => {
    const ex = await publishArtifactTool.handler({ title: 'T', ...args }, ctx())
    expect(ex.result).toMatchObject({ ok: false })
    expect(svc.publishArtifact).not.toHaveBeenCalled()
  })

  it('turns an ArtifactError into { ok:false, error } without throwing', async () => {
    svc.publishArtifact.mockRejectedValue(new ArtifactError('title is required', 'bad_input'))
    const ex = await publishArtifactTool.handler({ html: 'x' }, ctx())
    expect(ex.result).toEqual({ ok: false, error: 'title is required' })
  })

  it('warns about root-absolute asset refs (Vite without base ./)', async () => {
    const ex = await publishArtifactTool.handler({
      title: 'V', files: { 'index.html': '<script type="module" src="/assets/index.js"></script>', 'assets/index.js': 'x' }
    }, ctx())
    expect((ex.result as { warnings: string[] }).warnings.join(' ')).toContain('base: \'./\'')
  })

  it('reads workspace_path through the bundle reader and warns on masked/skipped', async () => {
    bundle.readWorkspaceBundle.mockResolvedValue({ files: [{ path: 'index.html', content: Buffer.from('<p/>') }], masked: 2, skipped: ['a.exe'] })
    const ex = await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist' }, ctx({ isTainted: () => false }))
    expect(bundle.readWorkspaceBundle).toHaveBeenCalledWith('ws-1', 'dist', expect.objectContaining({ tainted: false, offline: false }))
    const w = (ex.result as { warnings: string[] }).warnings.join('|')
    expect(w).toContain('2 file(s) had secret values masked')
    expect(w).toContain('a.exe')
  })

  it('workspace_path with no run (MCP) is a clean ok:false', async () => {
    const ex = await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist' }, ctx({ runId: undefined }))
    expect(ex.result).toMatchObject({ ok: false })
    expect(bundle.readWorkspaceBundle).not.toHaveBeenCalled()
  })

  it('a workspace read failure is ok:false', async () => {
    bundle.readWorkspaceBundle.mockRejectedValue(new Error('could not read dist: timed out'))
    const ex = await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist' }, ctx({ isTainted: () => false }))
    expect(ex.result).toEqual({ ok: false, error: 'could not read dist: timed out' })
  })

  describe('undo', () => {
    it('a created artifact is deleted', async () => {
      const ex = await publishArtifactTool.handler({ title: 'D', html: 'x' }, ctx())
      await ex.undo!()
      expect(svc.deleteArtifact).toHaveBeenCalledWith('a1')
    })
    it('a new version restores the previous one', async () => {
      svc.publishArtifact.mockResolvedValue(published({ created: false, version: 2, previousVersionId: 'v1' }))
      const ex = await publishArtifactTool.handler({ title: 'D', html: 'x', slug: 'dash' }, ctx())
      await ex.undo!()
      expect(svc.setCurrentVersion).toHaveBeenCalledWith('a1', 'v1')
    })
    it('an in-place data update has no undo', async () => {
      svc.publishArtifact.mockResolvedValue(published({ created: false, newVersion: false, version: 2 }))
      const ex = await publishArtifactTool.handler({ slug: 'dash', files: { 'data/a.json': '{}' }, merge: true }, ctx())
      expect(ex.undo).toBeUndefined()
      expect(ex.summary).toBe('updated data of "Dash" (v2, in place)')
    })
  })
})

describe('edit_artifact', () => {
  it('returns publish\'s ok shape and undo restores the snapshot', async () => {
    svc.resolveArtifactRef.mockResolvedValue('a1')
    svc.getArtifactDetail.mockResolvedValue({ ...art, description: 'd', projectId: null, versions: [{ id: 'v1', version: 1, current: true }] })
    svc.editArtifact.mockResolvedValue({ ...art, isPublic: true })
    const ex = await editArtifactTool.handler({ artifact: 'dash', public: true, rollback_to: 1 }, ctx())
    expect(ex.result).toMatchObject({ ok: true, id: 'a1', slug: 'dash', title: 'Dash', url: art.url, isPublic: true, version: 1, warnings: [] })
    await ex.undo!()
    expect(svc.editArtifact).toHaveBeenLastCalledWith('a1', expect.objectContaining({ isPublic: false, title: 'Dash', projectId: null }))
    expect(svc.setCurrentVersion).toHaveBeenCalledWith('a1', 'v1')
  })
  it('an unknown artifact is ok:false; a service ArtifactError too', async () => {
    svc.resolveArtifactRef.mockResolvedValue(null)
    expect((await editArtifactTool.handler({ artifact: 'x' }, ctx())).result).toMatchObject({ ok: false })
    svc.resolveArtifactRef.mockResolvedValue('a1')
    svc.getArtifactDetail.mockResolvedValue({ ...art, versions: [] })
    svc.editArtifact.mockRejectedValue(new ArtifactError('slug is already in use', 'bad_slug'))
    expect((await editArtifactTool.handler({ artifact: 'a1', slug: 's' }, ctx())).result).toEqual({ ok: false, error: 'slug is already in use' })
  })
})

describe('delete_artifact', () => {
  it('is dangerous, describes the approval, and undo restores', async () => {
    expect(deleteArtifactTool.dangerous).toBe(true)
    svc.resolveArtifactRef.mockResolvedValue('a1')
    svc.getArtifactDetail.mockResolvedValue({ ...art, versions: [] })
    expect(await deleteArtifactTool.describeApproval!({ artifact: 'dash' }, { approvalNonce: 'n' }))
      .toEqual({ tool: 'delete_artifact', command: 'delete artifact "Dash" (/artifact/dash/)', proposedPattern: 'delete_artifact *' })
    svc.deleteArtifact.mockResolvedValue(true)
    svc.restoreArtifact.mockResolvedValue(true)
    const ex = await deleteArtifactTool.handler({ artifact: 'dash' }, ctx())
    await ex.undo!()
    expect(svc.restoreArtifact).toHaveBeenCalledWith('a1')
  })
})

describe('outboundWhen', () => {
  it.each([publishArtifactTool, editArtifactTool])('$name is outbound only when public:true', (t) => {
    expect(t.outboundWhen!({ public: true })).toBe(true)
    expect(t.outboundWhen!({})).toBe(false)
    expect(t.outboundWhen!({ public: false })).toBe(false)
  })
})

describe('registration', () => {
  it('every tool is in the artifacts toolset, which exists; publish_artifact is registered', () => {
    expect(TOOLSETS.artifacts).toBeDefined()
    expect([...artifactTools, ...artifactDangerousTools].map(t => t.toolset)).toEqual(Array(4).fill('artifacts'))
    expect(artifactTools.some(t => t.dangerous)).toBe(false) // dangerous tools stay out of agentTools / MCP
    expect(toolByName('publish_artifact')).toBeDefined()
  })
})

describe('fix round 1', () => {
  const pubDetail = { ...art, isPublic: true, description: null, projectId: null, versions: [{ id: 'v1', version: 1, current: true }] }

  describe('tainted run + already-public target (gate level)', () => {
    const taintingRead = {
      name: 'gmail_search', description: 'd', kind: 'read' as const, toolset: 'gmail' as const, taints: true as const, schema: {},
      handler: async () => ({ result: { threads: [] }, summary: 's' })
    }
    function gate(ask?: (r: ApprovalRequest) => Promise<{ approved: boolean }>) {
      const set = buildAiTools([taintingRead, publishArtifactTool, editArtifactTool], { signal: new AbortController().signal, onEvent: () => {}, requestApproval: ask })
      return (n: string, i: Record<string, unknown>) => (set[n]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(i, { toolCallId: `c-${n}` })
    }
    beforeEach(() => {
      svc.resolveArtifactRef.mockResolvedValue('a1')
      svc.getArtifactDetail.mockResolvedValue(pubDetail)
      svc.editArtifact.mockResolvedValue({ ...art, isPublic: true })
    })
    it('merge-publish to a public slug without public:true is refused and writes nothing', async () => {
      const ask = vi.fn(async () => ({ approved: true }))
      const call = gate(ask)
      await call('gmail_search', {})
      const r = await call('publish_artifact', { slug: 'dash', files: { 'data/a.json': '{}' }, merge: true })
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('pass public: true') })
      expect(svc.publishArtifact).not.toHaveBeenCalled()
      expect(ask).not.toHaveBeenCalled()
    })
    it('the same call with public:true asks for approval (denied: nothing written)', async () => {
      const ask = vi.fn(async (_r: ApprovalRequest) => ({ approved: false }))
      const call = gate(ask)
      await call('gmail_search', {})
      expect(await call('publish_artifact', { slug: 'dash', files: { 'data/a.json': '{}' }, merge: true, public: true })).toEqual({ denied: true })
      expect(ask).toHaveBeenCalledTimes(1)
      expect(svc.publishArtifact).not.toHaveBeenCalled()
    })
    it('edit_artifact rollback_to on a public artifact is refused; with public:true it asks', async () => {
      const ask = vi.fn(async (_r: ApprovalRequest) => ({ approved: false }))
      const call = gate(ask)
      await call('gmail_search', {})
      expect(await call('edit_artifact', { artifact: 'dash', rollback_to: 1 })).toMatchObject({ ok: false })
      expect(svc.editArtifact).not.toHaveBeenCalled()
      expect(ask).not.toHaveBeenCalled()
      expect(await call('edit_artifact', { artifact: 'dash', rollback_to: 1, public: true })).toEqual({ denied: true })
      expect(ask).toHaveBeenCalledTimes(1)
    })
    it('an untainted run is not restricted', async () => {
      const call = gate(vi.fn(async () => ({ approved: false })))
      svc.publishArtifact.mockResolvedValue(published({ created: false, newVersion: false, version: 1 }))
      expect(await call('publish_artifact', { slug: 'dash', files: { 'data/a.json': '{}' }, merge: true })).toMatchObject({ ok: true })
    })
  })

  describe('replay pins (proposalArgs)', () => {
    beforeEach(() => bundle.readWorkspaceBundle.mockResolvedValue({ files: [{ path: 'index.html', content: Buffer.from('x') }], masked: 0, skipped: [] }))
    it('proposalArgs pins workspaceId and conversationId', async () => {
      const a = await publishArtifactTool.proposalArgs!({ title: 'T', workspace_path: 'dist', public: true }, ctx())
      expect(a).toMatchObject({ workspace_path: 'dist', workspaceId: 'ws-1', conversationId: 'conv-1' })
    })
    it('a live run ignores a model-supplied workspaceId/conversationId', async () => {
      await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist', workspaceId: '00000000-0000-4000-8000-000000000001', conversationId: '00000000-0000-4000-8000-000000000002' }, ctx({ isTainted: () => false }))
      expect(bundle.readWorkspaceBundle.mock.calls[0]![0]).toBe('ws-1')
      expect(svc.publishArtifact.mock.calls[0]![0].conversationId).toBe('conv-1')
    })
    it('MCP-shaped ctx (no runId, no replay) ignores a supplied workspaceId and refuses', async () => {
      const ex = await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist', workspaceId: 'someone-elses' }, ctx({ runId: undefined }))
      expect(ex.result).toMatchObject({ ok: false })
      expect(bundle.readWorkspaceBundle).not.toHaveBeenCalled()
      expect(store.get).not.toHaveBeenCalled()
    })
    it('MCP html publish ignores a supplied conversationId', async () => {
      await publishArtifactTool.handler({ title: 'T', html: 'x', conversationId: 'forged' }, ctx({ runId: undefined }))
      expect(svc.publishArtifact.mock.calls[0]![0].conversationId).toBeNull()
    })
    it('a replay with a deleted workspace is a clean ok:false', async () => {
      store.get.mockResolvedValue({ id: 'pinned-ws', deletedAt: new Date() })
      const ex = await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist', workspaceId: 'pinned-ws' }, ctx({ runId: undefined, replay: true }))
      expect(ex.result).toMatchObject({ ok: false })
      expect(bundle.readWorkspaceBundle).not.toHaveBeenCalled()
    })
    it('a replay uses the pinned ids', async () => {
      store.get.mockResolvedValue({ id: 'pinned-ws', deletedAt: null })
      svc.publishArtifact.mockResolvedValue(published())
      await publishArtifactTool.handler({ title: 'T', workspace_path: 'dist', workspaceId: 'pinned-ws', conversationId: 'pinned-conv' }, ctx({ runId: undefined, replay: true }))
      expect(bundle.readWorkspaceBundle.mock.calls[0]![0]).toBe('pinned-ws')
      expect(svc.publishArtifact.mock.calls[0]![0].conversationId).toBe('pinned-conv')
    })
  })

  describe('undo restores metadata', () => {
    it('new version + metadata change: undo reverts version AND settings', async () => {
      svc.resolveArtifactRef.mockResolvedValue('a1')
      svc.getArtifactDetail.mockResolvedValue({ ...art, isPublic: false, description: 'old', projectId: null, versions: [] })
      svc.publishArtifact.mockResolvedValue(published({ created: false, version: 2, previousVersionId: 'v1', artifact: { ...art, title: 'New', isPublic: true, description: 'old', projectId: null } }))
      const ex = await publishArtifactTool.handler({ slug: 'dash', title: 'New', html: 'x', public: true }, ctx())
      await ex.undo!()
      expect(svc.setCurrentVersion).toHaveBeenCalledWith('a1', 'v1')
      expect(svc.editArtifact).toHaveBeenCalledWith('a1', { title: 'Dash', description: 'old', isPublic: false, projectId: null })
      expect(svc.editArtifact.mock.invocationCallOrder[0]).toBeLessThan(svc.setCurrentVersion.mock.invocationCallOrder[0]!)
    })
    it('metadata-only change on an unchanged version: has undo, honest summary', async () => {
      svc.resolveArtifactRef.mockResolvedValue('a1')
      svc.getArtifactDetail.mockResolvedValue({ ...art, isPublic: false, description: null, projectId: null, versions: [] })
      svc.publishArtifact.mockResolvedValue(published({ created: false, newVersion: false, artifact: { ...art, isPublic: true, description: null, projectId: null } }))
      const ex = await publishArtifactTool.handler({ slug: 'dash', html: 'x', public: true }, ctx())
      expect(ex.undo).toBeDefined()
      expect(ex.summary).toContain('settings')
      await ex.undo!()
      expect(svc.setCurrentVersion).not.toHaveBeenCalled()
      expect(svc.editArtifact).toHaveBeenCalledWith('a1', expect.objectContaining({ isPublic: false }))
    })
  })

  it('normalises files keys before the entry lookup and root-absolute check', async () => {
    const ex = await publishArtifactTool.handler({ title: 'V', files: { './index.html': '<script src="/assets/i.js"></script>', 'assets//i.js': 'x' } }, ctx())
    expect(svc.publishArtifact.mock.calls[0]![0].files.map((f: { path: string }) => f.path)).toEqual(['index.html', 'assets/i.js'])
    expect((ex.result as { warnings: string[] }).warnings.join(' ')).toContain('base: \'./\'')
  })

  it('edit undo only resets the version when rollback_to was passed', async () => {
    svc.resolveArtifactRef.mockResolvedValue('a1')
    svc.getArtifactDetail.mockResolvedValue({ ...art, description: null, projectId: null, versions: [{ id: 'v1', version: 1, current: true }] })
    svc.editArtifact.mockResolvedValue(art)
    const ex = await editArtifactTool.handler({ artifact: 'dash', title: 'Z' }, ctx())
    await ex.undo!()
    expect(svc.setCurrentVersion).not.toHaveBeenCalled()
    const ex2 = await editArtifactTool.handler({ artifact: 'dash', rollback_to: 1 }, ctx())
    await ex2.undo!()
    expect(svc.setCurrentVersion).toHaveBeenCalledWith('a1', 'v1')
  })
})
