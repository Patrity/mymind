// Cycle 82 Task 2: the background-shell registry against a fake exec + in-memory store (the real
// container behaviour is in test/workspace-tools.db.test.ts).
import { describe, expect, it, vi } from 'vitest'
import { createShellRegistry, MAX_RUNNING_SHELLS, type ShellStore, type WorkspaceShellRow } from './shells'
import { parseShellStatus, shellOutputCommand, shellStartCommand, SHELL_STATUS_MARK } from './fs-ops'
import type { ExecOptions, SandboxExecResult } from './manager'
import type { WorkspaceRow } from './store'

vi.mock('../../db', () => ({ useDb: () => { throw new Error('no DB in unit tests') } }))

const WS = '55555555-5555-4555-8555-555555555555'
const res = (o: Partial<SandboxExecResult> = {}): SandboxExecResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, oom: false, aborted: false, truncated: false, tainted: false, ...o })

function memShells(): ShellStore & { rows: Map<string, WorkspaceShellRow> } {
  const rows = new Map<string, WorkspaceShellRow>()
  let n = 0
  return {
    rows,
    create: async (workspaceId, command) => {
      const id = `66666666-6666-4666-8666-${String(++n).padStart(12, '0')}`
      const r: WorkspaceShellRow = { id, workspaceId, command, state: 'running', exitCode: null, reason: null, readOffset: 0, startedAt: new Date(), endedAt: null }
      rows.set(id, r)
      return r
    },
    get: async id => rows.get(id) ?? null,
    listRunning: async ws => [...rows.values()].filter(r => r.state === 'running' && (!ws || r.workspaceId === ws)),
    list: async ws => [...rows.values()].filter(r => r.workspaceId === ws),
    end: async (id, p) => { const r = rows.get(id); if (!r || r.state !== 'running') return false; Object.assign(r, { state: p.state, exitCode: p.exitCode ?? null, reason: p.reason ?? null, endedAt: new Date() }); return true },
    setOffset: async (id, off) => { const r = rows.get(id); if (r) r.readOffset = off }
  }
}

function setup(ws: Partial<WorkspaceRow> = {}) {
  const store = memShells()
  const calls: Array<{ command: string; o?: ExecOptions }> = []
  let reply: (command: string) => SandboxExecResult = () => res()
  const workspace = { id: WS, state: 'running', tainted: false, deletedAt: null, ...ws } as WorkspaceRow
  const reg = createShellRegistry({
    exec: async (_id, command, o) => { calls.push({ command, o }); return reply(command) },
    workspace: async () => workspace,
    store,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  })
  return { reg, store, calls, workspace, setReply: (f: typeof reply) => { reply = f } }
}

const status = (st: string, size: number, n: number, out = '') => `${SHELL_STATUS_MARK}${st}:${size}:${n}\n${out}`

describe('fs-ops shell scripts', () => {
  it('the command goes in on stdin (never in argv); a bad id is refused', () => {
    expect(shellStartCommand('66666666-6666-4666-8666-000000000001')).toContain('cat > "$d/cmd"')
    expect(() => shellStartCommand('../../etc')).toThrow(/bad shell id/)
    expect(shellOutputCommand('66666666-6666-4666-8666-000000000001', 10, 100)).toContain('tail -c +11')
  })
  it('parseShellStatus', () => {
    expect(parseShellStatus(status('running', 12, 4, 'abcd'))).toEqual({ status: { state: 'running' }, size: 12, n: 4, output: 'abcd' })
    expect(parseShellStatus(status('exit:3', 0, 0))!.status).toEqual({ state: 'exited', exitCode: 3 })
    expect(parseShellStatus('garbage')).toBeNull()
  })
})

describe('shell registry', () => {
  it('start: the command travels as stdin; a launcher failure marks the row lost and throws', async () => {
    const { reg, calls, store, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:42\n' }))
    const s = await reg.start(WS, 'npm run dev')
    expect(s.pid).toBe(42)
    expect(calls[0]!.o!.input).toBe('npm run dev')
    expect(calls[0]!.command).not.toContain('npm run dev')
    setReply(() => res({ exitCode: 1, stderr: 'boom' }))
    await expect(reg.start(WS, 'x')).rejects.toThrow(/could not start/)
    expect([...store.rows.values()].at(-1)!.state).toBe('lost')
  })
  it(`caps running shells per workspace at ${MAX_RUNNING_SHELLS}`, async () => {
    const { reg, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    for (let i = 0; i < MAX_RUNNING_SHELLS; i++) await reg.start(WS, `s${i}`)
    await expect(reg.start(WS, 'one more')).rejects.toThrow(/already running/)
  })
  it('output is incremental (offset advances by what was returned) and settles exit / lost', async () => {
    const { reg, store, calls, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const { shellId } = await reg.start(WS, 'x')
    setReply(() => res({ stdout: status('running', 10, 4, 'abcd') }))
    expect(await reg.output(WS, shellId)).toMatchObject({ state: 'running', output: 'abcd', more: true })
    expect(store.rows.get(shellId)!.readOffset).toBe(4)
    setReply(() => res({ stdout: status('exit:0', 10, 6, 'efghij') }))
    const o = await reg.output(WS, shellId)
    expect(calls.at(-1)!.command).toContain('tail -c +5')
    expect(o).toMatchObject({ state: 'exited', exitCode: 0, output: 'efghij', more: false })
    const { shellId: s2 } = await (setReply(() => res({ stdout: '__mm_shell_pid__:2\n' })), reg.start(WS, 'y'))
    setReply(() => res({ stdout: status('gone', 0, 0) }))
    expect(await reg.output(WS, s2)).toMatchObject({ state: 'lost' })
    await expect(reg.output('77777777-7777-4777-8777-777777777777', s2)).rejects.toThrow(/no background shell/)
  })
  it('a shell lost after the workspace was tainted says why', async () => {
    const { reg, workspace, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const { shellId } = await reg.start(WS, 'x')
    workspace.tainted = true
    setReply(() => res({ stdout: status('gone', 3, 0), tainted: true }))
    expect((await reg.output(WS, shellId)).reason).toMatch(/network was turned off/)
  })
  it('killAll (onOverQuota, every 5s in a low-disk episode) is idempotent and only execs into a running, untainted sandbox', async () => {
    const { reg, calls, workspace, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    await reg.start(WS, 'a'); await reg.start(WS, 'b')
    calls.length = 0
    setReply(() => res({ stdout: status('running', 0, 0) }))
    expect(await reg.killAll(WS, 'over quota')).toBe(2)
    expect(calls).toHaveLength(2)
    calls.length = 0
    expect(await reg.killAll(WS, 'over quota')).toBe(0) // nothing left: no exec at all
    expect(calls).toHaveLength(0)
    // A stopped container (the watchdog killed it): rows are marked, nothing is started to kill nothing.
    setReply(() => res({ stdout: '__mm_shell_pid__:3\n' }))
    await reg.start(WS, 'c')
    workspace.state = 'stopped'
    calls.length = 0
    expect(await reg.killAll(WS, 'low disk')).toBe(1)
    expect(calls).toHaveLength(0)
  })
  it('boot reconcile: running → re-attached; exit file → exited; process gone → lost; sandbox stopped → lost without exec', async () => {
    const { reg, store, workspace, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const a = (await reg.start(WS, 'a')).shellId
    const b = (await reg.start(WS, 'b')).shellId
    const c = (await reg.start(WS, 'c')).shellId
    setReply((cmd) => res({ stdout: cmd.includes(a) ? status('running', 0, 0) : cmd.includes(b) ? status('exit:2', 0, 0) : status('gone', 0, 0) }))
    expect(await reg.reconcile()).toEqual({ reattached: 1, ended: 2 })
    expect([store.rows.get(a)!.state, store.rows.get(b)!.state, store.rows.get(b)!.exitCode, store.rows.get(c)!.state]).toEqual(['running', 'exited', 2, 'lost'])
    workspace.state = 'stopped'
    expect(await reg.reconcile()).toEqual({ reattached: 0, ended: 1 })
    expect(store.rows.get(a)!.state).toBe('lost')
  })
})
