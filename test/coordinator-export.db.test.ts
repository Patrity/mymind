// Cycle 83 Task 2 — export_to_coordinator against REAL Docker + the dev DB (spec D7): a child with its
// own workspace hands files up into its coordinator's workspace under /workspace/from/<childId>/.
// Skipped when Docker is not running. Every container carries mymind.test=<RUN>; workstream rows,
// their threads, the workspace rows (this file's bus namespace) and the temp dir are removed in afterAll.
process.loadEnvFile('.env')
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import { exportToCoordinatorTool, exportUnpackCommand, workspaceTools } from '@mymind/core/lib/agent/tools/workspace'
import { ZERO_USED } from '@mymind/core/shared/types/workstreams'
import type { ToolContext } from '@mymind/core/lib/agent/types'

const IMAGE = process.env.SANDBOX_TEST_IMAGE || 'mymind-sandbox:current'
const RUN = `t83x-${process.pid}-${Date.now().toString(36)}`
const NS = RUN.replace(/[^A-Za-z0-9_-]/g, '_')
const LABELS = { 'mymind.test': RUN }

function docker(...args: string[]): { code: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  return { code: r.status ?? -1, out: r.stdout ?? '' }
}
const dockerUp = docker('version', '--format', '{{.Server.Version}}').code === 0 && docker('image', 'inspect', IMAGE).code === 0

describe.skipIf(!dockerUp)('export_to_coordinator (real Docker)', () => {
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
      // A 20 MB quota: the uncompressed-size check (fix round 1, M4) bites at a testable size.
      labels: LABELS, settings: { image: IMAGE, workspacesDir: root, firewall: 'off', limits: 'off', maxRunning: 10, dns: [], quotaBytes: 20 * 1024 * 1024 },
      log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    rt = createWorkspaceRuntime(m, { resolve: async () => ({ workspaceId: as.workspaceId, kind: 'workstream', workstreamId: as.workstreamId, conversationId: null }) })
    setWorkspaceRuntime(rt)
  }, 120_000)

  afterAll(async () => {
    rt?.watches.stop()
    setWorkspaceRuntime(null)
    const ids = docker('ps', '-aq', '--filter', `label=mymind.test=${RUN}`).out.split('\n').filter(Boolean)
    if (ids.length) docker('rm', '-f', ...ids)
    await useDb().delete(workspaces).where(eq(workspaces.ns, NS))
    if (convIds.length) {
      await useDb().delete(workstreams).where(inArray(workstreams.conversationId, convIds))
      await useDb().delete(conversations).where(inArray(conversations.id, convIds))
    }
    setBusNs(null)
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('copies files and directories into the coordinator\'s workspace under from/<childId>/ (inside the sandbox; links dereferenced)', async () => {
    const coord = await workstream('T83X coordinator')
    const child = await workstream('T83X child', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)

    as = { workspaceId: childWs.id, workstreamId: child.id }
    expect((await call('bash', { command: 'mkdir -p out/deep && echo REPORT > out/report.md && echo DEEP > out/deep/x.txt && echo SOLO > solo.txt && ln -s /etc/hostname out/link' })).exitCode).toBe(0)
    const r = await call('export_to_coordinator', { paths: ['out', 'solo.txt'] })
    expect(r).toMatchObject({ ok: true, copied: ['out', 'solo.txt'], to: `from/${child.id}/` })
    expect(r.workspaceTainted).toBeUndefined()

    as = { workspaceId: coordWs.id, workstreamId: coord.id }
    const ls = await call('bash', { command: `cd from/${child.id} && find . -type f -o -type l | sort && cat out/report.md out/deep/x.txt solo.txt && test ! -L out/link && echo NOT-A-LINK` })
    expect(ls.stdout).toContain('./out/deep/x.txt\n./out/link\n./out/report.md\n./solo.txt\n')
    expect(ls.stdout).toContain('REPORT\nDEEP\nSOLO\nNOT-A-LINK')
    // The files never existed on the coordinator's side before (and only under from/<childId>/).
    expect((await call('bash', { command: 'ls' })).stdout.trim()).toBe('from')
  }, 180_000)

  it('refuses a top-level workstream, a shared child, `..`, absolute paths and .mymind; a tainted run taints the coordinator\'s workspace', async () => {
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
    // tar's own refusal (the missing path), not a later failure to unpack nothing.
    expect(await call('export_to_coordinator', { paths: ['missing.txt'] })).toMatchObject({ ok: false, error: expect.stringMatching(/export_to_coordinator failed: .*missing\.txt/) })

    // A tainted run: the copy runs with no network on both sides and taints the coordinator's workspace.
    expect((await call('bash', { command: 'echo MAIL > mail.txt' })).exitCode).toBe(0)
    tainted = true
    try {
      const r = await call('export_to_coordinator', { paths: ['mail.txt'] })
      expect(Object.keys(r)[0]).toBe('workspaceTainted')
      expect(r.ok).toBe(true)
    } finally { tainted = false }
    const [row] = await useDb().select().from(workspaces).where(eq(workspaces.id, coordWs.id))
    expect(row!.tainted).toBe(true)
  }, 180_000)

  it('M4: the UNCOMPRESSED size must fit the coordinator\'s remaining quota (a tiny gzip of 30 MB of zeros is refused, nothing lands)', async () => {
    const coord = await workstream('T83X coordinator 3')
    const child = await workstream('T83X zipbomb child', { parentId: coord.id })
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    const childWs = await ensureWorkstreamWorkspace(child.id)
    as = { workspaceId: childWs.id, workstreamId: child.id }
    expect((await call('bash', { command: 'head -c 31457280 /dev/zero > zeros.bin && echo ok' })).stdout).toContain('ok')
    const r = await call('export_to_coordinator', { paths: ['zeros.bin'] })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/too large to export: 3146\d{4} bytes uncompressed/) })
    as = { workspaceId: coordWs.id, workstreamId: coord.id }
    expect((await call('bash', { command: `test -e from/${child.id} && echo LANDED || echo NONE` })).stdout.trim()).toBe('NONE')
  }, 180_000)

  it('M4: the unpack itself (in the coordinator\'s sandbox) cuts decompression at the limit and refuses links — whatever size the child claimed', async () => {
    const coord = await workstream('T83X coordinator 4')
    const coordWs = await ensureWorkstreamWorkspace(coord.id)
    as = { workspaceId: coordWs.id, workstreamId: coord.id }
    // Archives built inside the sandbox, as a hostile child could: 5 MB of zeros, and a symlink.
    const mk = await call('bash', { command: 'mkdir -p /tmp/a/b && head -c 5242880 /dev/zero > /tmp/a/big && ln -s /etc/hostname /tmp/a/b/link && tar -C /tmp/a -czf - big | base64 -w0 > /tmp/big.b64 && tar -C /tmp/a -czf - b | base64 -w0 > /tmp/link.b64 && echo ok' })
    expect(mk.stdout).toContain('ok')
    const b64 = async (f: string) => (await call('bash', { command: `cat ${f}` })).stdout as string
    const m = rt.manager
    const big = await m.exec(coordWs.id, exportUnpackCommand('/workspace/from/x', 1024 * 1024), { input: await b64('/tmp/big.b64'), timeoutSec: 60 })
    expect(big.exitCode).toBe(3)
    const link = await m.exec(coordWs.id, exportUnpackCommand('/workspace/from/y', 10 * 1024 * 1024), { input: await b64('/tmp/link.b64'), timeoutSec: 60 })
    expect(link.exitCode).toBe(4)
    expect((await call('bash', { command: 'ls from 2>/dev/null | wc -l' })).stdout.trim()).toBe('0')
    // Under the limit, plain files: extracted.
    const ok = await m.exec(coordWs.id, exportUnpackCommand('/workspace/from/z', 10 * 1024 * 1024), { input: await b64('/tmp/big.b64'), timeoutSec: 60 })
    expect(ok.exitCode).toBe(0)
  }, 180_000)
})
