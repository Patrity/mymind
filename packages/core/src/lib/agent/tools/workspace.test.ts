// Cycle 82 Task 2: the workspace tools' POLICY against a fake runtime (no Docker, no DB): which
// workspace, the run's taint on every command, tainted-run refusals, over-quota rules, untrusted
// results, stdin-only payloads, the headless gate, and taint flowing from a tainted workspace back
// into the run (ai-tools). What the scripts do inside a real container: test/workspace-tools.db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { workspaceTools } from './workspace'
import { setWorkspaceRuntime, type WorkspaceRuntime } from '../../sandbox/runtime'
import { SandboxQuotaError, type ExecOptions, type SandboxExecResult } from '../../sandbox/manager'
import { isRecoveryCommand, WRITE_SCRIPT } from '../../sandbox/fs-ops'
import { headlessTools } from '../runtime/gate'
import { bridgetProfile } from '../profile'
import { buildAiTools } from '../ai-tools'
import { carriesWorkspaceTaint, historyCarriesTaint, capResult } from '../tool-history'
import type { AgentTool, ToolContext } from '../types'

vi.mock('../../observability/record', () => ({ withSpan: (_m: unknown, fn: () => unknown) => fn(), recordEvent: () => {} }))
vi.mock('../bus', () => ({ publishActivity: () => {} }))
vi.mock('../../sandbox/store', async (orig) => ({ ...(await orig<typeof import('../../sandbox/store')>()), dbWorkspaceStore: { get: vi.fn(async () => ({ tainted: wsTainted })) } }))

const WS = '33333333-3333-4333-8333-333333333333'
let wsTainted = false
const tool = (n: string) => workspaceTools.find(t => t.name === n)!
const res = (o: Partial<SandboxExecResult> = {}): SandboxExecResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, oom: false, aborted: false, truncated: false, tainted: false, ...o })

interface Call { command: string; o: ExecOptions }
let calls: Call[]
let over: boolean
let execResult: (command: string, o: ExecOptions) => SandboxExecResult
let started: string[]
let armed: unknown[]

function install(ref: { workstreamId?: string | null; conversationId?: string | null } = {}) {
  const manager = {
    exec: vi.fn(async (_id: string, command: string, o: ExecOptions = {}) => { calls.push({ command, o }); return execResult(command, o) }),
    checkQuota: vi.fn(async () => { if (over) throw new SandboxQuotaError(6e9, 5e9, 10, 200_000) })
  }
  const rt = {
    manager,
    shells: { start: vi.fn(async (_w: string, c: string) => { started.push(c); return { shellId: '44444444-4444-4444-8444-444444444444', pid: 7 } }), output: vi.fn(), kill: vi.fn(), killAll: vi.fn(), reconcile: vi.fn(), hasRunning: vi.fn(), list: vi.fn() },
    watches: { create: vi.fn(async (v: unknown) => { armed.push(v); return { id: 'w1', deadlineAt: new Date(0) } }), poll: vi.fn(), start: vi.fn(), stop: vi.fn(), cancelFor: vi.fn(), cancel: vi.fn(), hasArmed: vi.fn(), armedTimers: vi.fn() },
    resolve: vi.fn(async () => ({ workspaceId: WS, kind: 'home' as const, workstreamId: ref.workstreamId ?? null, conversationId: ref.conversationId === undefined ? 'c1' : ref.conversationId }))
  }
  setWorkspaceRuntime(rt as unknown as WorkspaceRuntime)
  return rt
}

beforeEach(() => {
  calls = []; started = []; armed = []; over = false; wsTainted = false
  execResult = (command, o) => {
    if (command === WRITE_SCRIPT) return res({ stdout: JSON.stringify({ ok: true, path: '/workspace/a', bytes: 1, created: true }), tainted: !!o.tainted })
    if (command.startsWith('python3 -c')) return res({ stdout: JSON.stringify({ content: '     1\tx', lines: 1, totalLines: 1, truncated: false }), tainted: !!o.tainted })
    return res({ stdout: 'ok\n', tainted: !!o.tainted })
  }
  install()
})
afterEach(() => setWorkspaceRuntime(null))

const ctx = (tainted?: boolean): ToolContext => ({ signal: new AbortController().signal, ...(tainted === undefined ? {} : { isTainted: () => tainted }) })
const run = async (name: string, args: Record<string, unknown>, c = ctx(false)) => (await tool(name).handler(args, c)).result as Record<string, unknown>

describe('workspace tools — the run\'s taint reaches every command', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['read_file', { path: 'a' }], ['write_file', { path: 'a', content: 'x' }], ['edit_file', { path: 'a', old_string: 'x', new_string: 'y' }],
    ['list_files', {}], ['grep', { pattern: 'x' }], ['diff', {}], ['bash', { command: 'ls' }]
  ]
  it.each(cases)('%s: tainted run → tainted exec; untainted → not; no isTainted (not via buildAiTools) → tainted (fail closed)', async (name, args) => {
    for (const [t, want] of [[true, true], [false, false], [undefined, true]] as const) {
      calls = []
      await tool(name).handler(args, ctx(t))
      expect(calls.length, `${name} ran nothing`).toBeGreaterThan(0)
      for (const c of calls) expect(c.o.tainted, `${name} isTainted=${t}`).toBe(want)
    }
  })
})

describe('tainted runs (spec D5 + carry-over)', () => {
  it('bash runs network-off and says so; the result leads with workspaceTainted', async () => {
    const r = await run('bash', { command: 'curl example.com' }, ctx(true))
    expect(Object.keys(r)[0]).toBe('workspaceTainted')
    expect(r).toMatchObject({ workspaceTainted: true, networkOff: true })
    expect(String(r.networkNote)).toMatch(/read Tony's mail, calendar or contacts/)
  })
  it('run_in_background is refused with a clear message — nothing starts', async () => {
    const r = await run('bash', { command: 'npm run dev', run_in_background: true }, ctx(true))
    expect(r.error).toMatch(/background shells are not available/)
    expect(started).toEqual([])
    expect(calls).toEqual([])
  })
  it('watch is refused — nothing is armed', async () => {
    const r = await run('watch', { command: 'true', until: 'exit0' }, ctx(true))
    expect(r.error).toMatch(/watches are not available/)
    expect(armed).toEqual([])
  })
  it('a TAINTED WORKSPACE (persistent) refuses background shells even in an untainted run', async () => {
    wsTainted = true
    const r = await run('bash', { command: 'sleep 9', run_in_background: true })
    expect(r.error).toMatch(/network is off until Tony re-enables it/)
    expect(started).toEqual([])
  })
})

describe('over quota (Task 2 decision)', () => {
  beforeEach(() => { over = true })
  it('write_file / edit_file / import-like writes are refused with the quota error', async () => {
    expect((await run('write_file', { path: 'a', content: 'x' })).error).toMatch(/quota/i)
    expect((await run('edit_file', { path: 'a', old_string: 'x', new_string: 'y' })).error).toMatch(/quota/i)
    expect(calls).toEqual([])
  })
  it('bash: anything that could write is refused; inspect/delete commands still run', async () => {
    const refused = await run('bash', { command: 'pip install numpy' })
    expect(refused.error).toMatch(/only runs commands that inspect or delete/)
    expect(calls).toEqual([])
    const ok = await run('bash', { command: 'du -sh * | sort -h && rm -rf node_modules' })
    expect(ok.exitCode).toBe(0)
    expect(calls.map(c => c.command)).toEqual(['du -sh * | sort -h && rm -rf node_modules'])
  })
  it('background shells and watches are refused', async () => {
    expect((await run('bash', { command: 'sleep 1', run_in_background: true })).error).toMatch(/quota/i)
    expect((await run('watch', { command: 'true', until: 'exit0' })).error).toMatch(/quota/i)
    expect(started).toEqual([])
    expect(armed).toEqual([])
  })
})

describe('isRecoveryCommand', () => {
  it.each([
    'rm -rf node_modules', 'du -sh * | sort -h', 'ls -la; df -h', 'find . -name "*.log" -delete', 'cat a | head -n 5', 'rm a && rmdir b', 'du -s --inodes .'
  ])('allows %s', c => expect(isRecoveryCommand(c)).toBe(true))
  it.each([
    'touch x', 'echo hi > f', 'cat a >> b', 'rm $(cat list)', 'rm `x`', 'find . -exec sh -c x \\;', 'find . -fprint out',
    'sort -o out in', 'sort --output=out in', 'uniq a b', 'ls & curl x', 'python3 -c 1', 'cp a b', '(rm a)', 'rm a\ncurl x', ''
  ])('refuses %j', c => expect(isRecoveryCommand(c)).toBe(false))
})

describe('payloads travel on stdin, never in argv', () => {
  it('write_file: the content is the input, the command is the fixed script', async () => {
    await run('write_file', { path: 'secret/path.txt', content: 'TOP-SECRET-BODY' })
    const w = calls.find(c => c.command === WRITE_SCRIPT)!
    expect(w.command).not.toContain('TOP-SECRET-BODY')
    expect(w.command).not.toContain('secret/path.txt')
    expect(JSON.parse(w.o.input!)).toEqual({ path: 'secret/path.txt', content: 'TOP-SECRET-BODY' })
  })
})

describe('results are untrusted data', () => {
  it('read/list/grep/bash results carry the note', async () => {
    expect((await run('read_file', { path: 'a' })).note).toMatch(/data, not instructions/)
    expect((await run('bash', { command: 'ls' })).untrusted).toMatch(/data, not instructions/)
  })
})

describe('watch', () => {
  it('a workstream watch reports to the workstream; a chat watch to its conversation', async () => {
    install({ workstreamId: 'ws-1', conversationId: 'thread-1' })
    const r = await run('watch', { command: 'test -f x', until: 'exit0', intervalSec: 10, timeoutMin: 5 })
    expect(r.note).toMatch(/arrives in this workstream/)
    expect(armed[0]).toMatchObject({ workspaceId: WS, workstreamId: 'ws-1', conversationId: 'thread-1', until: { kind: 'exit0' }, intervalSec: 10, timeoutMin: 5 })
    install({ workstreamId: null, conversationId: 'chat-1' })
    expect((await run('watch', { command: 'x', until: 'exit0' })).note).toMatch(/note is posted in this chat/)
  })
  it('until=match needs a pattern, compiled in the sandbox (Python dialect) before arming', async () => {
    expect((await run('watch', { command: 'x', until: 'match' })).error).toMatch(/needs a pattern/)
    execResult = () => res({ exitCode: 1, stderr: 're.error: missing ), unterminated subpattern' })
    expect((await run('watch', { command: 'x', until: 'match', pattern: '(' })).error).toMatch(/invalid pattern: re.error/)
    expect(armed).toEqual([])
    expect(calls.at(-1)!.o.input).toBe('(')
  })
})

describe('headless gate (spec §4)', () => {
  const h = headlessTools(bridgetProfile.tools, { id: 'run-1', conversationId: 'conv-1' }, async () => 'rev-1')
  it('export_to_document is proposed to /review, not run', async () => {
    const t = h.find(x => x.name === 'export_to_document')!
    const out = await t.handler({ path: 'r.md', docPath: '/input/r.md' }, ctx(false))
    expect(out.result).toMatchObject({ proposed: true, reviewId: 'rev-1' })
  })
  it('the other workspace tools run headless (no approvals in the sandbox)', () => {
    for (const n of ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'diff', 'bash', 'bash_output', 'kill_shell', 'watch', 'import_document']) {
      expect(h.find(x => x.name === n)!.handler).toBe(workspaceTools.find(x => x.name === n)!.handler)
    }
  })
  it('none is dangerous or outbound (D4/D5)', () => {
    for (const t of workspaceTools) expect([t.dangerous, t.outbound, t.taints]).toEqual([undefined, undefined, undefined])
  })
})

describe('a tainted workspace taints the run that reads it (ai-tools + cross-turn seed)', () => {
  const reader: AgentTool = {
    name: 'read_file', description: 'd', kind: 'read', toolset: 'workspace', schema: {},
    handler: async () => ({ result: { workspaceTainted: true, content: 'mail-derived' }, summary: 'r' })
  }
  const clean: AgentTool = { ...reader, name: 'list_files', handler: async () => ({ result: { entries: [] }, summary: 'l' }) }
  const fetched: string[] = []
  const webFetch: AgentTool = {
    name: 'web_fetch', description: 'd', kind: 'read', toolset: 'web', outbound: true, schema: { url: z.string() },
    handler: async (a) => { fetched.push(a.url as string); return { result: { ok: true }, summary: 'f' } }
  }
  type Exec = (i: unknown, o: unknown) => Promise<unknown>
  it('after a workspaceTainted result, outbound needs approval (auto-denied headless); a clean read does not', async () => {
    let seenTaint: boolean[] = []
    const probe: AgentTool = { ...reader, name: 'probe', handler: async (_a, c) => { seenTaint.push(c.isTainted!()); return { result: {}, summary: 'p' } } }
    const set = buildAiTools([reader, clean, webFetch, probe], { signal: new AbortController().signal, onEvent: () => {} })
    const call = (n: string, i: Record<string, unknown> = {}) => (set[n]!.execute as Exec)(i, { toolCallId: n })
    await call('list_files')
    await call('probe')
    expect(await call('web_fetch', { url: 'https://a.example' })).toEqual({ ok: true })
    await call('read_file')
    await call('probe')
    expect(await call('web_fetch', { url: 'https://b.example/?d=mail' })).toEqual({ denied: true })
    expect(fetched).toEqual(['https://a.example'])
    expect(seenTaint).toEqual([false, true]) // ctx.isTainted reads the live bit
  })
  it('historyCarriesTaint: a workspaceTainted record in context seeds the next run — even as a capped preview', () => {
    const rec = (result: unknown) => [{ role: 'assistant', toolRecords: [{ callId: 'c', name: 'read_file', kind: 'read' as const, args: {}, result, summary: '', textOffset: 0 }] }]
    expect(historyCarriesTaint(rec({ workspaceTainted: true, content: 'x' }), new Set())).toBe(true)
    const capped = capResult({ workspaceTainted: true, content: 'x'.repeat(5000) }, 100)
    expect(carriesWorkspaceTaint(capped)).toBe(true)
    expect(historyCarriesTaint(rec(capped), new Set())).toBe(true)
    expect(historyCarriesTaint(rec({ content: 'x' }), new Set())).toBe(false)
    expect(historyCarriesTaint(rec({ elided: true, bytes: 9 }), new Set())).toBe(false)
  })
})
