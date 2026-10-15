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
vi.mock('../../../services/projects', () => ({ getProject: async (s: string) => (s === 'mymind' ? { id: 'proj-1' } : null) }))

import { artifactTools, artifactDangerousTools, publishArtifactTool, editArtifactTool, deleteArtifactTool } from './artifacts'
import { ArtifactError } from '../../artifacts/limits'
import { TOOLSETS } from '../toolsets'
import { toolByName } from '../tools'
import type { ToolContext } from '../types'

const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ signal: new AbortController().signal, runId: 'run-1', ...o })
const art = { id: 'a1', slug: 'dash', title: 'Dash', url: 'https://x/artifact/dash/', isPublic: false, currentVersion: 1 }
const published = (o: object = {}) => ({ artifact: art, version: 1, created: true, newVersion: true, previousVersionId: null, ...o })

beforeEach(() => {
  vi.clearAllMocks()
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
    const ex = await editArtifactTool.handler({ artifact: 'dash', public: true }, ctx())
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
