// Cycle 82 Task 2 — the `workspace` tools against REAL Docker + the dev DB (spec §4, §8).
// Skipped when Docker is not running. Every container carries mymind.test=<RUN>; rows, docs and the
// temp dir are tracked and removed in afterAll. The tools run exactly as Bridget calls them
// (tool.handler with a ToolContext); only the workspace selection is pinned to this file's rows.
process.loadEnvFile('.env')
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { documents, workspaceShells, workspaces } from '@mymind/core/db/schema'
import { createSandboxManager, type SandboxManager } from '@mymind/core/lib/sandbox/manager'
import { createWorkspaceRuntime, setWorkspaceRuntime, runtimeHooks, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { workspaceTools } from '@mymind/core/lib/agent/tools/workspace'
import type { ToolContext } from '@mymind/core/lib/agent/types'
import type { WorkspaceWatchRow } from '@mymind/core/lib/sandbox/watches'

const IMAGE = process.env.SANDBOX_TEST_IMAGE || 'mymind-sandbox:current'
const RUN = `wst-${process.pid}-${Date.now().toString(36)}`
const LABELS = { 'mymind.test': RUN }
const tool = (name: string) => workspaceTools.find(t => t.name === name)!

function docker(...args: string[]): { code: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  return { code: r.status ?? -1, out: r.stdout ?? '' }
}
const dockerUp = docker('version', '--format', '{{.Server.Version}}').code === 0 && docker('image', 'inspect', IMAGE).code === 0

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(250)
  }
}

describe.skipIf(!dockerUp)('workspace tools (real Docker)', () => {
  const rowIds: string[] = []
  const docIds: string[] = []
  let root = ''
  let m: SandboxManager
  let rt: WorkspaceRuntime
  let current = ''
  const delivered: WorkspaceWatchRow[] = []
  let tainted = false
  const ctx = (): ToolContext => ({ signal: new AbortController().signal, isTainted: () => tainted })
  const call = async (name: string, args: Record<string, unknown>) => (await tool(name).handler(args, ctx())).result as Record<string, any>

  async function newWorkspace(): Promise<string> {
    const [r] = await useDb().insert(workspaces).values({ kind: 'workstream' }).returning()
    rowIds.push(r!.id)
    return r!.id
  }
  const mkManager = (settings: Parameters<typeof createSandboxManager>[0]['settings'] = {}) => createSandboxManager({
    labels: LABELS, settings: { image: IMAGE, workspacesDir: root, firewall: 'off', dns: [], ...settings },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  })
  const mkRuntime = (mgr: SandboxManager) => createWorkspaceRuntime(mgr, {
    // A chat run: watch notes would go to this conversation (captured by `deliver` here).
    resolve: async () => ({ workspaceId: current, kind: 'home', workstreamId: null, conversationId: '00000000-0000-4000-8000-000000000082' }),
    deliver: async (row) => { delivered.push(row); return 'delivered' }
  })

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-wst-')))
    m = mkManager()
    rt = mkRuntime(m)
    setWorkspaceRuntime(rt)
    current = await newWorkspace()
  }, 120_000)

  afterAll(async () => {
    rt?.watches.stop()
    setWorkspaceRuntime(null)
    const ids = docker('ps', '-aq', '--filter', `label=mymind.test=${RUN}`).out.split('\n').filter(Boolean)
    if (ids.length) docker('rm', '-f', ...ids)
    if (docIds.length) await useDb().delete(documents).where(inArray(documents.id, docIds))
    if (rowIds.length) await useDb().delete(workspaces).where(inArray(workspaces.id, rowIds))
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('write_file → read_file: dirs created, line numbers, a 300 KB file travels on stdin (not argv)', async () => {
    const w = await call('write_file', { path: 'src/deep/a.txt', content: 'alpha\nbeta\ngamma\n' })
    expect(w).toMatchObject({ ok: true, path: '/workspace/src/deep/a.txt', bytes: 17, created: true })
    expect(JSON.stringify(w)).not.toContain('alpha') // a receipt, never the content
    const r = await call('read_file', { path: 'src/deep/a.txt' })
    expect(r.content).toBe('     1\talpha\n     2\tbeta\n     3\tgamma')
    expect(r).toMatchObject({ lines: 3, totalLines: 3, truncated: false })
    expect(r.workspaceTainted).toBeUndefined()

    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(90)}`).join('\n')
    expect(Buffer.byteLength(big)).toBeGreaterThan(200_000)
    expect((await call('write_file', { path: 'big.txt', content: big })).ok).toBe(true)
    const r2 = await call('read_file', { path: 'big.txt' })
    // ≤ 2000 lines AND ≤ 100 KB of text: the byte cap bites first here.
    expect(r2.truncated).toBe(true)
    expect(r2.totalLines).toBe(3000)
    expect(r2.lines).toBeLessThan(2000)
    const r3 = await call('read_file', { path: 'big.txt', offset: 2999, limit: 5 })
    expect(r3.content).toMatch(/^ {2}2999\tline 2999 x+\n {2}3000\tline 3000 x+$/)
    expect(r3).toMatchObject({ startLine: 2999, lines: 2, truncated: false })
  }, 120_000)

  it('read_file caps at 2000 lines, detects binary, reports missing / directory', async () => {
    await call('bash', { command: 'seq 1 2500 > n.txt; printf "ab\\0cd" > bin.dat; mkdir -p d' })
    const r = await call('read_file', { path: 'n.txt' })
    expect(r).toMatchObject({ lines: 2000, totalLines: 2500, truncated: true })
    expect((await call('read_file', { path: 'bin.dat' }))).toMatchObject({ binary: true, bytes: 5 })
    expect((await call('read_file', { path: 'nope.txt' }))).toMatchObject({ ok: false, error: 'not_found' })
    expect((await call('read_file', { path: 'd' }))).toMatchObject({ ok: false, error: 'is_directory' })
  }, 120_000)

  it('edit_file: unique replace, ambiguity lists candidate lines, replace_all, no match', async () => {
    await call('write_file', { path: 'e.py', content: 'x = 1\ny = 2\nx = 1\n' })
    const amb = await call('edit_file', { path: 'e.py', old_string: 'x = 1', new_string: 'x = 3' })
    expect(amb).toMatchObject({ ok: false, error: 'ambiguous_match', count: 2, candidates: [1, 3] })
    expect((await call('read_file', { path: 'e.py' })).content).toContain('x = 1') // nothing written
    expect(await call('edit_file', { path: 'e.py', old_string: 'y = 2', new_string: 'y = "it\'s"' })).toMatchObject({ ok: true, replacements: 1 })
    expect(await call('edit_file', { path: 'e.py', old_string: 'x = 1', new_string: 'x = 9', replace_all: true })).toMatchObject({ ok: true, replacements: 2 })
    expect((await call('bash', { command: 'cat e.py' })).stdout).toBe('x = 9\ny = "it\'s"\nx = 9\n')
    expect(await call('edit_file', { path: 'e.py', old_string: 'zzz', new_string: 'q' })).toMatchObject({ ok: false, error: 'no_match' })
  }, 120_000)

  it('list_files: everything / a glob, ≤ 500 entries, bookkeeping and noise dirs skipped', async () => {
    await call('bash', { command: 'mkdir -p many node_modules/x .mymind && for i in $(seq 1 600); do : > many/f$i.txt; done; : > node_modules/x/i.js; : > .mymind/hidden' })
    const all = await call('list_files', {})
    expect(all.count).toBe(500)
    expect(all.truncated).toBe(true)
    const py = await call('list_files', { glob: '**/*.py' })
    expect(py.entries).toEqual(['e.py'])
    const some = await call('list_files', { path: 'src' })
    expect(some.entries).toEqual(['deep/a.txt'])
    const nm = await call('list_files', { glob: '**/*.js' })
    expect(nm.entries).toEqual([])
  }, 120_000)

  it('grep: matches as path:line:text, ≤ 200 with a truncation flag, none, a bad regex', async () => {
    const g = await call('grep', { pattern: 'gam+a', path: 'src' })
    expect(g.matches).toEqual(['src/deep/a.txt:3:gamma'])
    const many = await call('grep', { pattern: '^line', glob: 'big.txt' })
    expect(many.count).toBe(200)
    expect(many.truncated).toBe(true)
    expect(await call('grep', { pattern: 'no-such-thing-anywhere' })).toMatchObject({ count: 0, matches: [] })
    expect((await call('grep', { pattern: '(' })).ok).toBe(false)
  }, 120_000)

  it('diff: first use makes a git baseline; later changes and new files show', async () => {
    const d0 = await call('diff', {})
    expect(d0.initialized).toBe(true)
    expect(d0.diff.trim()).toBe('')
    await call('edit_file', { path: 'src/deep/a.txt', old_string: 'beta', new_string: 'BETA' })
    await call('write_file', { path: 'new.md', content: 'fresh\n' })
    const d1 = await call('diff', {})
    expect(d1.initialized).toBe(false)
    expect(d1.diff).toContain('-beta')
    expect(d1.diff).toContain('+BETA')
    expect(d1.diff).toContain('+fresh')
    const d2 = await call('diff', { path: 'new.md' })
    expect(d2.diff).not.toContain('BETA')
  }, 120_000)

  it('bash foreground: exit code, output, timeout', async () => {
    const r = await call('bash', { command: 'echo out; echo err >&2; exit 3' })
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    const t = await call('bash', { command: 'sleep 5', timeout: 1 })
    expect(t.timedOut).toBe(true)
  }, 120_000)

  it('background shell → incremental bash_output → exit code; another → kill_shell', async () => {
    const s = await call('bash', { command: 'echo one; sleep 2; echo two; exit 4', run_in_background: true })
    expect(s.state).toBe('running')
    const first = await until(async () => { const o = await call('bash_output', { shellId: s.shellId }); return o.output ? o : null })
    expect(first.output).toBe('one\n')
    const done = await until(async () => { const o = await call('bash_output', { shellId: s.shellId }); return o.state !== 'running' ? o : null }, 20_000)
    expect(done).toMatchObject({ state: 'exited', exitCode: 4, output: 'two\n' })
    // Incremental: nothing new on the next read.
    expect((await call('bash_output', { shellId: s.shellId })).output).toBe('')

    const k = await call('bash', { command: 'while true; do echo tick; sleep 0.2; done', run_in_background: true })
    await sleep(800)
    expect((await call('kill_shell', { shellId: k.shellId })).state).toBe('killed')
    // The whole process group is gone (the loop's text is in a file, not argv: check by group id).
    const after = (await m.exec(current, `kill -0 -${k.pid} 2>/dev/null && echo alive || echo none`)).stdout
    expect(after.trim()).toBe('none')
    expect((await call('kill_shell', { shellId: k.shellId })).alreadyEnded).toBe(true)
  }, 120_000)

  it('a worker restart re-attaches a running shell; a restarted sandbox marks it lost', async () => {
    const s = await call('bash', { command: 'sleep 300', run_in_background: true })
    // A new worker: fresh manager + runtime over the same rows and container.
    const rt2 = mkRuntime(mkManager())
    const r1 = await rt2.shells.reconcile()
    expect(r1.reattached).toBeGreaterThanOrEqual(1)
    const [row] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, s.shellId))
    expect(row!.state).toBe('running')
    // The container is recreated (e.g. a new image): its processes are gone without an exit code.
    docker('restart', '-t', '0', `mymind-ws-${current}`)
    await rt2.shells.reconcile()
    const [lost] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, s.shellId))
    expect(lost!.state).toBe('lost')
    expect(lost!.reason).toMatch(/went away|stopped/)
  }, 120_000)

  it('the manager isBusy hook keeps a workspace with a running shell or armed watch from idle-stopping', async () => {
    const hooks = runtimeHooks(rt)
    const s = await call('bash', { command: 'sleep 60', run_in_background: true })
    expect(await hooks.isBusy(current)).toBe(true)
    await call('kill_shell', { shellId: s.shellId })
    expect(await hooks.isBusy(current)).toBe(false)
  }, 120_000)

  it('watch until exit0 fires when a background job finishes; until match fires on output', async () => {
    delivered.length = 0
    await call('bash', { command: 'sleep 3; touch built.flag', run_in_background: true })
    const w = await call('watch', { command: 'test -f built.flag', until: 'exit0', intervalSec: 5, timeoutMin: 2 })
    expect(w.watchId).toBeTruthy()
    const done = await until(async () => delivered.find(d => d.id === w.watchId), 40_000)
    expect(done.state).toBe('met')
    expect(done.resultText).toMatch(/The watch you set is done: `test -f built.flag` exits 0/)

    const w2 = await call('watch', { command: 'echo "status: READY (v2)"', until: 'match', pattern: 'READY \\(v\\d\\)', intervalSec: 5 })
    const d2 = await until(async () => delivered.find(d => d.id === w2.watchId), 30_000)
    expect(d2.state).toBe('met')
    expect(d2.resultText).toContain('status: READY (v2)')
    expect((await call('watch', { command: 'true', until: 'match', pattern: '(' })).error).toMatch(/invalid pattern/)
  }, 120_000)

  it('watch timeout; a watch survives a worker restart (re-armed at boot)', async () => {
    delivered.length = 0
    const short = await rt.watches.create({ workspaceId: current, workstreamId: null, conversationId: null, command: 'false', until: { kind: 'exit0' }, intervalSec: 5, timeoutMin: 0.1 })
    const t = await until(async () => delivered.find(d => d.id === short.id), 30_000)
    expect(t.state).toBe('timeout')
    expect(t.resultText).toMatch(/timed out/)

    // Armed on worker A, which stops (drain) before it fires…
    const rtA = mkRuntime(mkManager())
    const w = await rtA.watches.create({ workspaceId: current, workstreamId: null, conversationId: null, command: 'test -f later.flag', until: { kind: 'exit0' }, intervalSec: 5, timeoutMin: 5 })
    await sleep(500)
    rtA.watches.stop()
    await call('bash', { command: 'touch later.flag' })
    await sleep(6000)
    expect(delivered.find(d => d.id === w.id)).toBeUndefined() // nobody polls it now
    // …worker B boots and re-arms it.
    const rtB = mkRuntime(mkManager())
    expect(await rtB.watches.start()).toBeGreaterThanOrEqual(1)
    const fired = await until(async () => delivered.find(d => d.id === w.id), 30_000)
    expect(fired.state).toBe('met')
    rtB.watches.stop()
  }, 120_000)

  it('import_document → file; export_to_document → a new document, then replaces it (undo restores)', async () => {
    const { createDoc, getDoc } = await import('@mymind/core/services/documents')
    const src = await createDoc({ path: `/input/wst-${RUN}-src.md`, content: '# From docs\n\nhello sandbox\n' })
    docIds.push(src.id)
    expect(await call('import_document', { docId: src.id, path: 'imported/doc.md' })).toMatchObject({ ok: true, docId: src.id })
    expect((await call('bash', { command: 'cat imported/doc.md' })).stdout).toBe('# From docs\n\nhello sandbox\n')

    await call('write_file', { path: 'report.md', content: '# Report\n\nv1\n' })
    const docPath = `/input/wst-${RUN}-report.md`
    const e1 = await tool('export_to_document').handler({ path: 'report.md', docPath }, ctx())
    const r1 = e1.result as Record<string, any>
    docIds.push(r1.id)
    expect(r1).toMatchObject({ ok: true, path: docPath, from: '/workspace/report.md' })
    expect((await getDoc(r1.id))!.content).toBe('# Report\n\nv1\n')
    await call('write_file', { path: 'report.md', content: '# Report\n\nv2\n' })
    const e2 = await tool('export_to_document').handler({ path: 'report.md', docPath }, ctx())
    expect(e2.result).toMatchObject({ ok: true, id: r1.id, replaced: true })
    expect((await getDoc(r1.id))!.content).toBe('# Report\n\nv2\n')
    expect(await e2.undo!()).toMatchObject({ ok: true })
    expect((await getDoc(r1.id))!.content).toBe('# Report\n\nv1\n')
    // Binary refused.
    expect((await call('export_to_document', { path: 'bin.dat', docPath: `/input/wst-${RUN}-bin.md` })).ok).toBe(false)
  }, 120_000)

  it('over quota: writes refused, bash only inspects/deletes, and freeing space recovers', async () => {
    const id = await newWorkspace()
    const prev = current
    current = id
    const small = mkManager({ quotaInodes: 50 })
    const q = mkRuntime(small)
    setWorkspaceRuntime(q)
    try {
      await call('bash', { command: 'mkdir junk && for i in $(seq 1 80); do : > junk/$i; done' })
      // The quota is measured at most once a minute: force a fresh measurement.
      await small.measure(id)
      expect((await call('write_file', { path: 'x.txt', content: 'x' })).error).toMatch(/quota/i)
      const refused = await call('bash', { command: 'touch y.txt' })
      expect(refused.error).toMatch(/only runs commands that inspect or delete/)
      expect((await call('bash', { command: 'echo hi > z.txt' })).error).toMatch(/only runs/)
      expect((await call('bash', { command: 'du -s --inodes .', timeout: 30 })).exitCode).toBe(0)
      expect((await call('bash', { command: 'rm -rf junk' })).exitCode).toBe(0)
      await small.measure(id)
      expect((await call('write_file', { path: 'x.txt', content: 'x' })).ok).toBe(true)
    } finally {
      setWorkspaceRuntime(rt)
      current = prev
    }
  }, 120_000)

  // LAST (it taints its own workspace for good).
  it('a tainted run: bash runs with no network (and taints the workspace); background and watch are refused', async () => {
    const id = await newWorkspace()
    const prev = current
    current = id
    try {
      await call('write_file', { path: 'pre.txt', content: 'before' })
      tainted = true
      const r = await call('bash', { command: "cat pre.txt; awk 'NR>1' /proc/net/route | wc -l" })
      expect(Object.keys(r)[0]).toBe('workspaceTainted') // first key: survives a capped preview
      expect(r).toMatchObject({ workspaceTainted: true, networkOff: true, exitCode: 0 })
      expect(r.stdout).toBe('before0\n')
      const bg = await call('bash', { command: 'sleep 1', run_in_background: true })
      expect(bg.error).toMatch(/background shells are not available/)
      const w = await call('watch', { command: 'true', until: 'exit0' })
      expect(w.error).toMatch(/watches are not available/)
      expect((await useDb().select().from(workspaceShells).where(eq(workspaceShells.workspaceId, id))).length).toBe(0)
      // The run is untainted again, but the WORKSPACE stays tainted: reads say so (and would taint the
      // reader); background shells stay refused until Tony re-enables the network.
      tainted = false
      const rd = await call('read_file', { path: 'pre.txt' })
      expect(rd.workspaceTainted).toBe(true)
      expect((await call('bash', { command: 'sleep 1', run_in_background: true })).error).toMatch(/network is off until Tony re-enables it/)
    } finally {
      tainted = false
      current = prev
    }
  }, 120_000)
})
