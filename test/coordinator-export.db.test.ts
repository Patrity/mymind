// Cycle 83 Task 2 / cycle 86 — export_to_coordinator on the HOST runtime + the dev DB (spec D7): a child
// with its own workspace hands files up into its coordinator's workspace under from/<childId>/ — a
// native copy (regular files and dirs only, sized before anything is written, never through a link).
// Workstream rows, their threads, the workspace rows (this file's bus namespace) and the temp dir are
// removed in afterAll.
process.loadEnvFile('.env')
import { mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { conversations, workspaces, workstreams } from '@mymind/core/db/schema'
import { createSandboxManager, type SandboxManager } from '@mymind/core/lib/sandbox/manager'
import { createWorkspaceRuntime, setWorkspaceRuntime, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { ensureWorkstreamWorkspace } from '@mymind/core/lib/sandbox/store'
import { EXPORT_MAX_ENTRIES, exportToCoordinatorTool, workspaceTools } from '@mymind/core/lib/agent/tools/workspace'
import { ZERO_USED } from '@mymind/core/shared/types/workstreams'
import type { ToolContext } from '@mymind/core/lib/agent/types'

const RUN = `t83x-${process.pid}-${Date.now().toString(36)}`
const NS = RUN.replace(/[^A-Za-z0-9_-]/g, '_')

describe('export_to_coordinator (host runtime)', () => {
  const convIds: string[] = []
  let root = ''
  let m: SandboxManager
  let rt: WorkspaceRuntime
  // Which workstream the "run" belongs to (the tools resolve the workspace through the runtime).
  let as: { workspaceId: string; workstreamId: string } = { workspaceId: '', workstreamId: '' }
  let tainted = false
  const ctx = (): ToolContext => ({ signal: new AbortController().signal, isTainted: () => tainted })
  const ws = (name: string) => workspaceTools.find(t => t.name === name)!
  const call = async (name: string, args: Record<string, unknown>) =>
    (await (name === 'export_to_coordinator' ? exportToCoordinatorTool : ws(name)).handler(args, ctx())).result as Record<string, any>

  async function workstream(goal: string, o: { parentId?: string; workspaceMode?: 'own' | 'shared' } = {}) {
    const [conv] = await useDb().insert(conversations).values({ title: `⚙ ${goal}` }).returning()
    convIds.push(conv!.id)
    const [row] = await useDb().insert(workstreams).values({
      conversationId: conv!.id, goal, state: 'running', used: ZERO_USED, budget: { maxSteps: 10, maxWallMs: 600_000 },
      parentId: o.parentId ?? null, isChild: !!o.parentId, workspaceMode: o.workspaceMode ?? 'own'
    }).returning()
    return row!
  }

  beforeAll(async () => {
    setBusNs(NS)
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-t83x-')))
    m = createSandboxManager({
      settings: { workspacesDir: root }, taintConfinement: async () => false, record: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    rt = createWorkspaceRuntime(m, { resolve: async () => ({ workspaceId: as.workspaceId, kind: 'workstream', workstreamId: as.workstreamId, conversationId: null }) })
    setWorkspaceRuntime(rt)
  }, 120_000)

  afterAll(async () => {
    rt?.watches.stop()
    setWorkspaceRuntime(null)
    await useDb().delete(workspaces).where(eq(workspaces.ns, NS))
    if (convIds.length) {
      await useDb().delete(workstreams).where(inArray(workstreams.conversationId, convIds))
      await useDb().delete(conversations).where(inArray(conversations.id, convIds))
    }
    setBusNs(null)
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  const dirOf = (id: string) => path.join(root, id)

  it('copies files and directories into the coordinator\'s workspace under from/<childId>/ — symlinks skipped and listed, never followed', async () => {
    const coord = await workstream('T83X coordinator')
    const child = await workstream('T83X child', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)

    as = { workspaceId: childWs.id, workstreamId: child.id }
    const secretFile = path.join(root, `secret-${RUN}`)
    writeFileSync(secretFile, 'TONY-ONLY')
    expect((await call('bash', { command: `mkdir -p out/deep && echo REPORT > out/report.md && echo DEEP > out/deep/x.txt && echo SOLO > solo.txt && ln -s ${secretFile} out/link` })).exitCode).toBe(0)
    const r = await call('export_to_coordinator', { paths: ['out', 'solo.txt'] })
    expect(r).toMatchObject({ ok: true, copied: ['out', 'solo.txt'], to: `from/${child.id}/`, skipped: ['out/link'] })
    expect(r.workspaceTainted).toBeUndefined()

    as = { workspaceId: coordWs.id, workstreamId: coord.id }
    const ls = await call('bash', { command: `cd from/${child.id} && find . -type f -o -type l | sort && cat out/report.md out/deep/x.txt solo.txt` })
    expect(ls.stdout).toBe('./out/deep/x.txt\n./out/report.md\n./solo.txt\nREPORT\nDEEP\nSOLO\n')
    expect(existsSync(path.join(dirOf(coordWs.id), 'from', child.id, 'out', 'link'))).toBe(false)
    // The files never existed on the coordinator's side before (and only under from/<childId>/).
    expect((await call('bash', { command: 'ls' })).stdout.trim()).toBe('from')
  }, 60_000)

  it('refuses a top-level workstream, a shared child, `..`, absolute paths, .mymind, a missing path and a symlinked parent; a tainted run taints the coordinator\'s workspace', async () => {
    const coord = await workstream('T83X coordinator 2')
    const shared = await workstream('T83X shared child', { parentId: coord.id, workspaceMode: 'shared' })
    const child = await workstream('T83X child 2', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)

    as = { workspaceId: coordWs.id, workstreamId: coord.id }
    expect(await call('export_to_coordinator', { paths: ['x'] })).toMatchObject({ ok: false, error: expect.stringMatching(/only for a child workstream/) })
    as = { workspaceId: coordWs.id, workstreamId: shared.id }
    expect(await call('export_to_coordinator', { paths: ['x'] })).toMatchObject({ ok: false, error: expect.stringMatching(/share your coordinator's workspace/) })
    as = { workspaceId: childWs.id, workstreamId: child.id }
    for (const bad of ['../x', '/etc/passwd', '.mymind/shells', 'a/../../b', '.']) {
      expect((await call('export_to_coordinator', { paths: [bad] })).ok, bad).toBe(false)
    }
    expect(await call('export_to_coordinator', { paths: ['missing.txt'] })).toMatchObject({ ok: false, error: expect.stringMatching(/missing\.txt: no such file or directory/) })
    // A symlinked parent can't lead the copy out of the child's workspace.
    const outside = path.join(root, `outside-${RUN}`)
    mkdirSync(outside, { recursive: true }); writeFileSync(path.join(outside, 'f'), 'OUT')
    symlinkSync(outside, path.join(dirOf(childWs.id), 'escape'))
    expect(await call('export_to_coordinator', { paths: ['escape/f'] })).toMatchObject({ ok: false, error: expect.stringMatching(/escape\/f: outside your workspace/) })

    // A tainted run: the copy marks the coordinator's workspace tainted (its files may be mail-derived).
    expect((await call('bash', { command: 'echo MAIL > mail.txt' })).exitCode).toBe(0)
    tainted = true
    try {
      const r = await call('export_to_coordinator', { paths: ['mail.txt'] })
      expect(Object.keys(r)[0]).toBe('workspaceTainted')
      expect(r.ok).toBe(true)
    } finally { tainted = false }
    const [row] = await useDb().select().from(workspaces).where(eq(workspaces.id, coordWs.id))
    expect(row!.tainted).toBe(true)
    const [src] = await useDb().select().from(workspaces).where(eq(workspaces.id, childWs.id))
    expect(src!.tainted).toBe(true)
  }, 60_000)

  it('sized BEFORE anything is written: 200 MB (a sparse 201 MB file) or more than 20,000 entries is refused, nothing lands', async () => {
    const coord = await workstream('T83X coordinator 3')
    const child = await workstream('T83X big child', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)
    as = { workspaceId: childWs.id, workstreamId: child.id }
    expect((await call('bash', { command: `python3 -c "open('sparse.bin','wb').truncate(201*1024*1024)" && mkdir many && python3 -c "[open('many/f%d' % i, 'w').close() for i in range(${EXPORT_MAX_ENTRIES + 1})]" && echo small > small.txt && echo ok` })).stdout).toContain('ok')
    expect(await call('export_to_coordinator', { paths: ['small.txt', 'sparse.bin'] })).toMatchObject({ ok: false, error: expect.stringMatching(/more than 209715200 bytes/) })
    expect(await call('export_to_coordinator', { paths: ['many'] })).toMatchObject({ ok: false, error: expect.stringMatching(/more than 20000 files/) })
    expect(existsSync(path.join(dirOf(coordWs.id), 'from', child.id))).toBe(false)
  }, 120_000)

  it('never writes through a link planted in the coordinator\'s workspace', async () => {
    const coord = await workstream('T83X coordinator 4')
    const child = await workstream('T83X child 4', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)
    const target = path.join(root, `planted-${RUN}`)
    mkdirSync(target, { recursive: true })
    await m.ensureDir(coordWs.id)
    // The coordinator's `from` is a link to somewhere else on the machine.
    symlinkSync(target, path.join(dirOf(coordWs.id), 'from'))
    as = { workspaceId: childWs.id, workstreamId: child.id }
    await call('bash', { command: 'echo X > x.txt' })
    expect(await call('export_to_coordinator', { paths: ['x.txt'] })).toMatchObject({ ok: false, error: expect.stringMatching(/from: the destination is not a directory/) })
    expect(existsSync(path.join(target, child.id))).toBe(false)
    // A plain destination works; a file planted as a link under it is refused, not written through.
    rmSync(path.join(dirOf(coordWs.id), 'from'))
    mkdirSync(path.join(dirOf(coordWs.id), 'from', child.id), { recursive: true })
    writeFileSync(path.join(target, 'victim'), 'SAFE')
    symlinkSync(path.join(target, 'victim'), path.join(dirOf(coordWs.id), 'from', child.id, 'x.txt'))
    expect(await call('export_to_coordinator', { paths: ['x.txt'] })).toMatchObject({ ok: false, error: expect.stringMatching(/x\.txt: the destination is not a regular file/) })
    expect(readFileSync(path.join(target, 'victim'), 'utf8')).toBe('SAFE')
  }, 60_000)
})
