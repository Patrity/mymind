// Cycle 86 Task 1 — the host workspace runtime against the dev DB: real rows, real processes. Replaces
// cycle 82's real-Docker sandbox.db.test.ts (its container-isolation checks are moot: clean runs own
// the machine). Proves on real rows: use bookkeeping, secrets in env never in argv, persistent taint
// (option C: the flag is set, nothing is stopped or confined), the idle stop, and the 30-day sweep
// (files removed, a symlink's target never followed). Rows live in this file's own bus namespace;
// rows, processes and the temp dir are removed in afterAll.
process.loadEnvFile('.env')
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { workspaces, workspaceShells } from '@mymind/core/db/schema'
import { createSandboxManager, IDLE_STOP_REASON, type SandboxManager } from '@mymind/core/lib/sandbox/manager'
import { createWorkspaceRuntime, runtimeHooks, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { dbWorkspaceStore } from '@mymind/core/lib/sandbox/store'

const RUN = `wsh-${process.pid}-${Date.now().toString(36)}`
const NS = RUN.replace(/[^A-Za-z0-9_-]/g, '_')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('host workspace runtime (dev DB, real processes)', () => {
  let root = ''
  let m: SandboxManager
  let rt: WorkspaceRuntime
  let now = Date.now()

  async function newWorkspace(): Promise<string> {
    const [r] = await useDb().insert(workspaces).values({ kind: 'workstream', ns: NS }).returning()
    return r!.id
  }

  beforeAll(() => {
    setBusNs(NS)
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-wsh-')))
    m = createSandboxManager({
      settings: { workspacesDir: root }, now: () => now,
      // The runtime's own hooks (shells killed on stop, watches keep it busy).
      onStopped: (id, why) => runtimeHooks(rt).onStopped(id, why),
      isBusy: id => runtimeHooks(rt).isBusy(id),
      log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    rt = createWorkspaceRuntime(m, { resolve: async () => { throw new Error('unused') } })
  })

  afterAll(async () => {
    rt?.watches.stop()
    for (const r of await useDb().select().from(workspaceShells).innerJoin(workspaces, eq(workspaces.id, workspaceShells.workspaceId)).where(eq(workspaces.ns, NS))) {
      if (r.workspace_shells.state === 'running') await rt.shells.kill(r.workspace_shells.workspaceId, r.workspace_shells.id).catch(() => {})
    }
    await useDb().delete(workspaces).where(eq(workspaces.ns, NS))
    setBusNs(null)
    if (root) rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('a command marks its row running and used; MyMind\'s own (internal) scripts never count as use', async () => {
    const id = await newWorkspace()
    const before = (await dbWorkspaceStore.get(id))!
    expect(before.state).toBe('stopped')
    now = Date.now()
    await sleep(20)
    expect((await m.exec(id, 'pwd')).stdout).toBe(`${path.join(root, id)}\n`)
    const after = (await dbWorkspaceStore.get(id))!
    expect(after.state).toBe('running')
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(before.lastUsedAt.getTime())
    await sleep(20)
    await m.exec(id, 'true', { internal: true })
    expect((await dbWorkspaceStore.get(id))!.lastUsedAt.getTime()).toBe(after.lastUsedAt.getTime())
  })

  it('an opted-in secret is in the command\'s env, never in any process\'s argv', async () => {
    const id = await newWorkspace()
    const value = `mm-secret-${RUN}`
    // `[m]m-secret-…` matches the value but not itself (this command's and grep's own argv).
    const r = await m.exec(id, `ps -A -ww -o args= | grep -c -- "[m]m-secret-${RUN}" || true; printf %s "$MM_T_SECRET" | wc -c`, { secrets: { MM_T_SECRET: value } })
    const [inArgv, len] = r.stdout.trim().split('\n')
    expect(Number(inArgv)).toBe(0)
    expect(Number(len)).toBe(value.length)
  })

  it('the idle stop: 15 min with no command and no armed watch kills the workspace\'s shells and marks it stopped', async () => {
    const id = await newWorkspace()
    now = Date.now()
    const s = await rt.shells.start(id, 'sleep 120')
    expect((await dbWorkspaceStore.get(id))!.state).toBe('running')
    await useDb().update(workspaces).set({ lastUsedAt: new Date(now - 16 * 60_000) }).where(eq(workspaces.id, id))
    expect(await m.idleStop()).toContain(id)
    await sleep(300)
    expect(alive(s.pid)).toBe(false)
    expect(await rt.shells.list(id)).toEqual([expect.objectContaining({ state: 'killed', reason: IDLE_STOP_REASON })])
    expect((await dbWorkspaceStore.get(id))!.state).toBe('stopped')
  }, 30_000)

  it('persistent taint (option C): the first tainted command flags the row; the clean run\'s background shell keeps running and later commands run unconfined', async () => {
    const id = await newWorkspace()
    now = Date.now()
    const s = await rt.shells.start(id, 'sleep 120')
    expect(alive(s.pid)).toBe(true)
    try {
      const t = await m.exec(id, 'echo hi', { tainted: true })
      expect(t).toMatchObject({ stdout: 'hi\n', tainted: true })
      expect(t).not.toHaveProperty('confined')
      expect((await dbWorkspaceStore.get(id))).toMatchObject({ tainted: true, taintedAt: expect.any(Date) })
      await sleep(300)
      expect(alive(s.pid)).toBe(true)
      expect(await rt.shells.list(id)).toEqual([expect.objectContaining({ state: 'running' })])
      // A later untainted command: reported tainted (the row is), not confined, writes where it likes.
      const later = await m.exec(id, 'echo x > out.txt && echo ok')
      expect(later).toMatchObject({ stdout: 'ok\n', tainted: true })
      expect(later).not.toHaveProperty('confined')
      expect(existsSync(path.join(root, id, 'out.txt'))).toBe(true)
    } finally {
      await rt.shells.kill(id, s.shellId).catch(() => {})
    }
  }, 30_000)

  it('the 30-day sweep: a deleted workstream\'s workspace loses its dir (a symlink\'s target untouched) and its row', async () => {
    const id = await newWorkspace() // kind workstream, workstream_id NULL → stamped as an orphan
    const outside = path.join(root, `keep-${RUN}`)
    mkdirSync(outside); writeFileSync(path.join(outside, 'f'), 'KEEP')
    await m.exec(id, 'mkdir -p d && echo x > d/x')
    symlinkSync(outside, path.join(root, id, 'link'))
    now = Date.now() + 5_000 // the stamp (deleted_at = now()) is older than the cutoff
    const gone = await m.sweep(0)
    expect(gone).toContain(id)
    expect(existsSync(path.join(root, id))).toBe(false)
    expect(readFileSync(path.join(outside, 'f'), 'utf8')).toBe('KEEP')
    expect(await dbWorkspaceStore.get(id)).toBeNull()
  }, 30_000)

  it('health: the workspaces dir is writable and (macOS) sandbox-exec works', async () => {
    expect(await m.health()).toMatchObject({ ok: true })
  })
})
