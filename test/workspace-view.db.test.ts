// Cycle 82 Task 3 / cycle 86 — the Files / Shells UI reads and workspace secrets on the HOST runtime +
// the dev DB. Rows, processes and the temp dir are removed in afterAll. The secret store is faked here
// (the dev DB's real exec secrets are never touched); everything else — the manager, the scripts, the
// processes — is real. The confined part needs macOS sandbox-exec.
process.loadEnvFile('.env')
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const SECRET = 'mm-test-SECRET-value-82'
const secretStore = vi.hoisted(() => ({ opted: {} as Record<string, string> }))
vi.mock('@mymind/core/lib/exec/secrets', async orig => ({
  ...(await orig<typeof import('@mymind/core/lib/exec/secrets')>()),
  getSandboxOptedSecrets: async () => ({ ...secretStore.opted }),
  getDecryptedSecrets: async () => ({ MM_TEST_SECRET: 'mm-test-SECRET-value-82' })
}))

const published = vi.hoisted(() => [] as Array<{ resource: string; id?: string }>)
vi.mock('@mymind/core/utils/live-bus', async orig => {
  const real = await orig<typeof import('@mymind/core/utils/live-bus')>()
  return { ...real, publishChange: (e: { resource: string; id?: string }) => { published.push(e); return real.publishChange(e as never) } }
})

import { inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { workspaces, workspaceShells } from '@mymind/core/db/schema'
import { eq } from 'drizzle-orm'
import { createSandboxManager, type SandboxManager } from '@mymind/core/lib/sandbox/manager'
import { createWorkspaceRuntime, setWorkspaceRuntime, type WorkspaceRuntime } from '@mymind/core/lib/sandbox/runtime'
import { killShellFromUi, readChunk, shellTail, viewFile, viewTree, VIEW_SCRIPT, CHUNK_BYTES } from '@mymind/core/lib/sandbox/view'
import { workspaceTools } from '@mymind/core/lib/agent/tools/workspace'
import type { ToolContext } from '@mymind/core/lib/agent/types'

const RUN = `wsv-${process.pid}-${Date.now().toString(36)}`
// Final fix wave: every workspace row of this file is in its own bus namespace — a dev worker on the
// shared DB never scans it, and afterAll removes every row of it (no orphans).
const NS = RUN.replace(/[^A-Za-z0-9_-]/g, '_')

const darwin = process.platform === 'darwin'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('workspace UI reads + workspace secrets (host runtime)', () => {
  const rowIds: string[] = []
  let root = ''
  let m: SandboxManager
  let rt: WorkspaceRuntime
  let ws = ''
  let tainted = false
  const sh = (cmd: string) => m.exec(ws, cmd, { timeoutSec: 60 })
  const ctx = (): ToolContext => ({ signal: new AbortController().signal, isTainted: () => tainted })
  const bash = async (command: string) => (await workspaceTools.find(t => t.name === 'bash')!.handler({ command }, ctx())).result as Record<string, any>

  beforeAll(async () => {
    setBusNs(NS)
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-wsv-')))
    m = createSandboxManager({ settings: { workspacesDir: root }, taintConfinement: async () => true, record: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } })
    const [r] = await useDb().insert(workspaces).values({ kind: 'workstream', ns: NS }).returning()
    rowIds.push(r!.id)
    ws = r!.id
    rt = createWorkspaceRuntime(m, { resolve: async () => ({ workspaceId: ws, kind: 'home', workstreamId: null, conversationId: null }) })
    setWorkspaceRuntime(rt)
    const s = await sh([
      'mkdir -p src/deep node_modules/pkg .mymind/x',
      'printf "print(1)\\n" > src/deep/a.py',
      'printf "# Title\\n\\nhello\\n" > README.md',
      ': > node_modules/pkg/index.js',
      'ln -s /etc/passwd passwd-link',
      'ln -s / rootlink',
      'seq 1 2500 > lines.txt',
      // one long line per 100 KB → 1.5 MB in 15 lines: the BYTE cap bites, not the line cap
      'python3 -c "import sys; [sys.stdout.write(\'y\' * 99999 + \'\\n\') for _ in range(15)]" > wide.txt',
      'printf "ab\\0cd" > bin.dat',
      'head -c 1500000 /dev/urandom > blob.bin',
      `printf "token=${SECRET}\\n" > leaked.txt`
    ].join(' && '))
    expect(s.exitCode, s.stderr).toBe(0)
  }, 180_000)

  afterAll(async () => {
    for (const r of await useDb().select().from(workspaceShells).where(eq(workspaceShells.workspaceId, ws))) {
      if (r.state === 'running') await rt.shells.kill(ws, r.id).catch(() => {})
    }
    setWorkspaceRuntime(null)
    if (rowIds.length) await useDb().delete(workspaces).where(inArray(workspaces.id, rowIds))
    await useDb().delete(workspaces).where(eq(workspaces.ns, NS))
    setBusNs(null)
    if (root) rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('tree: sizes, dirs first, noise dirs listed but not entered, .mymind too, symlinks as links (not followed)', async () => {
    const t = await viewTree(ws)
    const by = Object.fromEntries(t.entries.map(e => [e.path, e]))
    expect(by['src/deep/a.py']).toMatchObject({ type: 'file', bytes: 9 })
    expect(by['node_modules']).toMatchObject({ type: 'dir', skipped: true })
    expect(by['node_modules/pkg']).toBeUndefined()
    expect(by['.mymind']).toMatchObject({ skipped: true })
    expect(by['passwd-link']).toMatchObject({ type: 'link', target: '/etc/passwd' })
    expect(by['rootlink']).toMatchObject({ type: 'link', target: '/' })
    expect(Object.keys(by).some(p => p.startsWith('rootlink/'))).toBe(false)
    expect(t.entries.findIndex(e => e.path === 'src')).toBeLessThan(t.entries.findIndex(e => e.path === 'README.md'))
  }, 60_000)

  it('reads do not re-publish an unchanged workspace (the UI refetches on every workspace event — a publish per read looped)', async () => {
    await viewTree(ws) // container up and recorded
    published.length = 0
    await viewTree(ws)
    await viewFile(ws, 'README.md')
    expect(published.filter(e => e.resource === 'workspace' && e.id === ws)).toEqual([])
    const { dbWorkspaceStore } = await import('@mymind/core/lib/sandbox/store')
    await dbWorkspaceStore.setUsage(ws, 123, 4)
    await dbWorkspaceStore.setUsage(ws, 123, 4)
    await dbWorkspaceStore.setContainer(ws, null, 'stopped')
    await dbWorkspaceStore.setContainer(ws, null, 'stopped')
    expect(published.filter(e => e.resource === 'workspace' && e.id === ws)).toHaveLength(2)
  }, 60_000)

  it('tree caps at 500 entries', async () => {
    await sh('mkdir -p many && cd many && for i in $(seq 1 600); do : > f$i; done')
    const t = await viewTree(ws)
    expect(t.count).toBe(500)
    expect(t.truncated).toBe(true)
    await sh('rm -rf many')
  }, 60_000)

  it('view: text, the 2000-line cap, the 1 MB cap, binary', async () => {
    expect(await viewFile(ws, 'README.md')).toMatchObject({ binary: false, bytes: 15, lines: 3, truncated: false, content: '# Title\n\nhello\n' })
    const l = await viewFile(ws, 'lines.txt')
    expect(l).toMatchObject({ truncated: true, lines: 2000 })
    expect(l.content!.split('\n').at(-2)).toBe('2000')
    const w = await viewFile(ws, 'wide.txt')
    expect(w.truncated).toBe(true)
    expect(Buffer.byteLength(w.content!)).toBeLessThanOrEqual(1_000_000)
    expect(Buffer.byteLength(w.content!)).toBeGreaterThan(900_000)
    expect(w.bytes).toBe(1_500_000)
    expect(await viewFile(ws, 'bin.dat')).toEqual({ path: 'bin.dat', binary: true, bytes: 5 })
  }, 60_000)

  it('path safety: the read is resolved by the script (realpath) — symlinks out of the workspace are refused', async () => {
    await expect(viewFile(ws, 'passwd-link')).rejects.toMatchObject({ code: 'outside' })
    await expect(viewFile(ws, 'rootlink/etc/passwd')).rejects.toMatchObject({ code: 'outside' })
    await expect(readChunk(ws, 'rootlink/etc/passwd', 0, 10)).rejects.toMatchObject({ code: 'outside' })
    await expect(viewFile(ws, 'nope.txt')).rejects.toMatchObject({ code: 'not_found' })
    await expect(viewFile(ws, 'src')).rejects.toMatchObject({ code: 'not_a_file' })
    // Rejected before any exec (the JS check) …
    for (const p of ['/etc/passwd', '../x', 'src/../../etc/passwd']) await expect(viewFile(ws, p)).rejects.toMatchObject({ code: 'bad_path' })
    // … and the script's own check holds on its own (given a bad path directly).
    for (const p of ['/etc/passwd', '../etc/passwd', 'a/../../etc/passwd']) {
      const r = await m.exec(ws, VIEW_SCRIPT, { input: JSON.stringify({ path: p }) })
      expect(JSON.parse(r.stdout.split('\n')[0]!)).toMatchObject({ error: 'bad_path' })
    }
  }, 60_000)

  it('M3: a workspace file named json.py / base64.py / os.py cannot hijack a UI read or a tool (python3 -I)', async () => {
    const forged = 'import sys; sys.stdout.write(\'{"binary": false, "bytes": 1, "lines": 1, "truncated": false}\\nFORGED\'); sys.exit(0)'
    await sh(`for m in json base64 os stat; do printf '%s\\n' ${JSON.stringify(forged).replace(/\$/g, '\\$')} > $m.py; done; ls *.py`)
    try {
      expect(await viewFile(ws, 'README.md')).toMatchObject({ content: '# Title\n\nhello\n' })
      await expect(viewFile(ws, 'passwd-link')).rejects.toMatchObject({ code: 'outside' })
      expect((await readChunk(ws, 'README.md', 0, 100)).data).toBe(Buffer.from('# Title\n\nhello\n').toString('base64'))
      expect((await viewTree(ws)).entries.some(e => e.path === 'json.py')).toBe(true)
      const r = (await workspaceTools.find(t => t.name === 'read_file')!.handler({ path: 'README.md' }, ctx())).result as Record<string, any>
      expect(r.content).toContain('# Title')
      expect(JSON.stringify(r)).not.toContain('FORGED')
    } finally {
      await sh('rm -f json.py base64.py os.py stat.py')
    }
  }, 60_000)

  it('download chunks reassemble the exact file; length 0 = size only', async () => {
    const size = (await readChunk(ws, 'blob.bin', 0, 0))
    expect(size).toMatchObject({ size: 1_500_000, data: '' })
    const parts: Buffer[] = []
    for (let off = 0; off < size.size; off += CHUNK_BYTES) {
      const c = await readChunk(ws, 'blob.bin', off, Math.min(CHUNK_BYTES, size.size - off))
      expect(c.mtimeNs).toBe(size.mtimeNs)
      parts.push(Buffer.from(c.data, 'base64'))
    }
    const got = Buffer.concat(parts)
    const want = (await sh('(sha256sum blob.bin 2>/dev/null || shasum -a 256 blob.bin)')).stdout.split(' ')[0]
    expect(createHash('sha256').update(got).digest('hex')).toBe(want)
  }, 120_000)

  it('secret VALUES are masked in a file view (the file holds it; the UI never shows it)', async () => {
    const v = await viewFile(ws, 'leaked.txt')
    expect(v.content).toBe('token=«redacted»\n')
  }, 60_000)

  it('M1: a secret straddling the 1 MB view cut shows no visible half', async () => {
    await sh(`python3 -c "import sys; sys.stdout.write('y' * 999995 + '${SECRET}' + '\\n')" > straddle.txt`)
    try {
      const v = await viewFile(ws, 'straddle.txt')
      expect(v.truncated).toBe(true)
      expect(v.content!.endsWith('y')).toBe(true)
      expect(v.content).not.toContain(SECRET.slice(0, 3))
    } finally { await sh('rm -f straddle.txt') }
  }, 60_000)

  it('shells: the tail never moves bash_output\'s offset; Kill stops the group and records it', async () => {
    const s = await rt.shells.start(ws, 'i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done')
    await sleep(1500)
    const t = await shellTail(ws, s.shellId)
    expect(t.state).toBe('running')
    expect(t.output).toMatch(/tick 0\ntick 1/)
    const [row] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, s.shellId))
    expect(row!.readOffset).toBe(0)
    const k = await killShellFromUi(ws, s.shellId)
    expect(k).toMatchObject({ state: 'killed', alreadyEnded: false })
    const [after] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, s.shellId))
    expect(after!.reason).toMatch(/stopped by Tony/)
    await sleep(300)
    expect((await sh(`kill -0 -${s.pid} 2>/dev/null && echo alive || echo none`)).stdout.trim()).toBe('none')
    expect((await killShellFromUi(ws, s.shellId)).alreadyEnded).toBe(true)
  }, 60_000)

  it('fix round 2: bash_output over a real non-UTF-8 stream is contiguous across reads and masked', async () => {
    // 40 000 ASCII bytes, then a € straddling nothing in particular, an invalid byte, the secret, an emoji.
    const s = await rt.shells.start(ws, `python3 -c "import sys; sys.stdout.buffer.write(b'x' * 32767 + '€'.encode() + b' \\xff ' + b'${SECRET}' + ' 🙂 end'.encode())"`)
    let st = 'running'
    for (let i = 0; i < 40 && st === 'running'; i++) { await sleep(250); st = (await shellTail(ws, s.shellId)).state }
    const parts: string[] = []
    for (let i = 0; i < 10; i++) { const o = await rt.shells.output(ws, s.shellId); parts.push(o.output); if (!o.more) break }
    const want = Buffer.concat([Buffer.from('x'.repeat(32767)), Buffer.from('€'), Buffer.from([0x20, 0xff, 0x20]), Buffer.from('«redacted»'), Buffer.from(' 🙂 end')]).toString('utf8')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(want)
  }, 60_000)

  it('secrets: an opted-in secret is in `env` of an untainted command (value masked); reserved names never; a tainted run gets none', async () => {
    secretStore.opted = { MM_TEST_SECRET: SECRET, DOCKER_HOST: 'tcp://evil:2375', HOME: '/root' }
    try {
      tainted = false
      const r = await bash('env')
      expect(r.stdout).toContain('MM_TEST_SECRET=«redacted»')
      expect(JSON.stringify(r)).not.toContain(SECRET)
      expect(r.stdout).not.toContain('DOCKER_HOST')
      expect(r.stdout).toContain(`\nHOME=${homedir()}\n`)
      // The value really is there (proved without printing it).
      expect((await bash('[ "$MM_TEST_SECRET" = "' + SECRET + '" ] && echo same')).stdout.trim()).toBe('same')
      // A background shell gets it too.
      const bg = (await workspaceTools.find(t => t.name === 'bash')!.handler({ command: 'env | grep ^MM_TEST', run_in_background: true }, ctx())).result as Record<string, any>
      let tl = await shellTail(ws, bg.shellId)
      for (let i = 0; i < 40 && tl.state === 'running'; i++) { await sleep(250); tl = await shellTail(ws, bg.shellId) }
      expect(tl.output).toBe('MM_TEST_SECRET=«redacted»\n')
      if (!darwin) return // confinement needs macOS sandbox-exec
      tainted = true
      const t = await bash('env')
      expect(t.confined).toMatchObject({ reason: 'tainted-run' })
      expect(t.stdout).not.toContain('MM_TEST_SECRET')
      // The workspace is now tainted: an UNTAINTED run gets none either (and runs confined).
      tainted = false
      const u = await bash('env')
      expect(u.stdout).not.toContain('MM_TEST_SECRET')
      expect(u.confined).toMatchObject({ reason: 'tainted-workspace' })
    } finally {
      secretStore.opted = {}
      tainted = false
    }
  }, 180_000)
})
