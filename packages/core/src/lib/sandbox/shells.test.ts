// Cycle 82 Task 2 / cycle 86: the background-shell registry against a fake exec + in-memory store (the
// real process-group behaviour is in manager.test.ts and test/workspace-tools.db.test.ts).
import { describe, expect, it, vi } from 'vitest'
import { createShellRegistry, safeWindowEnd, SHELL_OUTPUT_CHUNK, type ShellStore, type WorkspaceShellRow } from './shells'
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

function setup(ws: Partial<WorkspaceRow> = {}, values: string[] = []) {
  const store = memShells()
  const calls: Array<{ command: string; o?: ExecOptions }> = []
  let reply: (command: string) => SandboxExecResult = () => res()
  const workspace = { id: WS, state: 'running', tainted: false, deletedAt: null, ...ws } as WorkspaceRow
  const reg = createShellRegistry({
    exec: async (_id, command, o) => { calls.push({ command, o }); return reply(command) },
    peek: async (_id, command) => { calls.push({ command, o: { internal: true } }); return reply(command) },
    workspace: async () => workspace,
    store,
    secretValues: async () => values,
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
    // Cycle 86: portable (macOS base64 has no -w; no /proc, no setsid, no GNU stat).
    expect(shellOutputCommand('66666666-6666-4666-8666-000000000001', 10, 100)).toContain("| base64 | tr -d '\\n'")
    for (const c of [shellStartCommand('66666666-6666-4666-8666-000000000001'), shellOutputCommand('66666666-6666-4666-8666-000000000001', 0, 1)]) {
      expect(c).not.toMatch(/\/proc\/|\bsetsid\b(?! *\()|stat -c|base64 -w/)
    }
    expect(shellStartCommand('66666666-6666-4666-8666-000000000001')).toContain('os.setsid()')
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
  it('cycle 86: no per-workspace cap on running shells (Bridget owns the machine)', async () => {
    const { reg, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    for (let i = 0; i < 12; i++) await reg.start(WS, `s${i}`)
  })
  it('the start carries the run\'s options (its taint marks the workspace); a confined launch is lost, never a shell', async () => {
    const { reg, calls, store, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    await reg.start(WS, 'x', { tainted: true, audit: { tool: 'bash' } })
    expect(calls[0]!.o).toMatchObject({ tainted: true, audit: { tool: 'bash' }, input: 'x' })
    setReply(() => res({ stdout: '__mm_shell_pid__:2\n', tainted: true, confined: { reason: 'tainted-workspace' } }))
    await expect(reg.start(WS, 'y')).rejects.toThrow(/not available while commands run confined/)
    expect([...store.rows.values()].at(-1)!.state).toBe('lost')
  })
  it('output is incremental (offset advances by what was returned) and settles exit / lost', async () => {
    const { reg, store, calls, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const { shellId } = await reg.start(WS, 'x')
    setReply(() => res({ stdout: status('running', 10, 4, Buffer.from('abcd').toString('base64')) }))
    expect(await reg.output(WS, shellId)).toMatchObject({ state: 'running', output: 'abcd', more: true })
    expect(store.rows.get(shellId)!.readOffset).toBe(4)
    setReply(() => res({ stdout: status('exit:0', 10, 6, Buffer.from('efghij').toString('base64')) }))
    const o = await reg.output(WS, shellId)
    expect(calls.at(-1)!.command).toContain('tail -c +5')
    expect(o).toMatchObject({ state: 'exited', exitCode: 0, output: 'efghij', more: false })
    const { shellId: s2 } = await (setReply(() => res({ stdout: '__mm_shell_pid__:2\n' })), reg.start(WS, 'y'))
    setReply(() => res({ stdout: status('gone', 0, 0) }))
    expect(await reg.output(WS, s2)).toMatchObject({ state: 'lost' })
    await expect(reg.output('77777777-7777-4777-8777-777777777777', s2)).rejects.toThrow(/no background shell/)
  })
  it('a shell lost after the workspace was tainted says why', async () => {
    const { reg, workspace, calls, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const { shellId } = await reg.start(WS, 'x')
    workspace.tainted = true
    setReply(() => res({ stdout: status('gone', 3, 0), tainted: true }))
    expect((await reg.output(WS, shellId)).reason).toMatch(/confined \(it handled mail\/calendar content\)/)
    // bash_output's read is MyMind's own script: internal, never confined.
    expect(calls.at(-1)!.o).toMatchObject({ internal: true })
  })
  it('killAll (taint / idle / teardown) is idempotent and always reaches the process through peek — whatever the workspace state or taint', async () => {
    const { reg, calls, workspace, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    await reg.start(WS, 'a'); await reg.start(WS, 'b')
    calls.length = 0
    setReply(() => res({ stdout: status('running', 0, 0) }))
    expect(await reg.killAll(WS, 'tainted')).toBe(2)
    expect(calls.map(c => c.o)).toEqual([{ internal: true }, { internal: true }])
    calls.length = 0
    expect(await reg.killAll(WS, 'tainted')).toBe(0) // nothing left: no command at all
    expect(calls).toHaveLength(0)
    // A stopped or tainted workspace: the kill still runs (cycle 82 skipped it — a dead container).
    setReply(() => res({ stdout: '__mm_shell_pid__:3\n' }))
    await reg.start(WS, 'c')
    Object.assign(workspace, { state: 'stopped', tainted: true })
    calls.length = 0
    expect(await reg.killAll(WS, 'idle')).toBe(1)
    expect(calls).toHaveLength(1)
  })
  it('boot reconcile: running → re-attached; exit file → exited; process gone → lost; a deleted workspace → lost without a command', async () => {
    const { reg, store, workspace, calls, setReply } = setup()
    setReply(() => res({ stdout: '__mm_shell_pid__:1\n' }))
    const a = (await reg.start(WS, 'a')).shellId
    const b = (await reg.start(WS, 'b')).shellId
    const c = (await reg.start(WS, 'c')).shellId
    setReply((cmd) => res({ stdout: cmd.includes(a) ? status('running', 0, 0) : cmd.includes(b) ? status('exit:2', 0, 0) : status('gone', 0, 0) }))
    expect(await reg.reconcile()).toEqual({ reattached: 1, ended: 2 })
    expect([store.rows.get(a)!.state, store.rows.get(b)!.state, store.rows.get(b)!.exitCode, store.rows.get(c)!.state]).toEqual(['running', 'exited', 2, 'lost'])
    // A stopped workspace keeps its live shell (processes outlive the worker on the host).
    workspace.state = 'stopped'
    expect(await reg.reconcile()).toEqual({ reattached: 1, ended: 0 })
    workspace.deletedAt = new Date()
    calls.length = 0
    expect(await reg.reconcile()).toEqual({ reattached: 0, ended: 1 })
    expect(store.rows.get(a)!.state).toBe('lost')
    expect(calls).toHaveLength(0)
  })
})

async function startedShell(reg: ReturnType<typeof setup>['reg'], setReply: ReturnType<typeof setup>['setReply']): Promise<string> {
  setReply(() => res({ stdout: '__mm_shell_pid__:42\n' }))
  return (await reg.start(WS, 'job')).shellId
}

describe('Task 3 fix round 1 (M1): a secret is never split across a bash_output window or a tail cut', () => {
  const SECRET = 'ghp_SplitMe_0123456789'
  const C = SECRET.length

  it('safeWindowEnd: a value straddling the chunk edge moves the edge back to its start', () => {
    const B = (t: string) => Buffer.from(t)
    const text = 'a'.repeat(10) + SECRET + 'tail'
    expect(safeWindowEnd(B(text), 15, [SECRET], false)).toBe(10)
    expect(safeWindowEnd(B(text), 10 + C, [SECRET], false)).toBe(10 + C) // ends exactly after it: whole
    expect(safeWindowEnd(B('abc ' + SECRET.slice(0, 7)), 100, [SECRET], true)).toBe(4) // half-written, still running
    expect(safeWindowEnd(B('abc ' + SECRET.slice(0, 7)), 100, [SECRET], false)).toBe(11) // finished: nothing more will come
    expect(safeWindowEnd(B('ab€cd'), 3, [], false)).toBe(2) // never inside a code point
    expect(safeWindowEnd(Buffer.concat([B('ab'), B('€').subarray(0, 2)]), 100, [], true)).toBe(2) // half-written code point held back
  })

  it('two windows over a secret straddling the 32 KB edge: neither shows any part of it unmasked', async () => {
    const { reg, store, setReply } = setup({}, [SECRET])
    const s = await startedShell(reg, setReply)
    const pad = 'x'.repeat(SHELL_OUTPUT_CHUNK - 5)
    const file = pad + SECRET + '\nend\n'
    setReply(streamShell(Buffer.from(file), 'exit:0'))
    const a = await reg.output(WS, s)
    const b = await reg.output(WS, s)
    const both = a.output + b.output
    expect(both).not.toContain(SECRET.slice(0, 6))
    expect(both).not.toContain(SECRET.slice(-6))
    expect(both).toBe(pad + '«redacted»\nend\n')
    expect(a.more).toBe(true)
    expect(b.more).toBe(false)
    expect(store.rows.get(s)!.readOffset).toBe(file.length)
  })

  it('a running shell that has written only the first half of a secret: that half is held back', async () => {
    const { reg, store, setReply } = setup({}, [SECRET])
    const s = await startedShell(reg, setReply)
    const file = 'log line\nAuthorization: ' + SECRET.slice(0, 9)
    setReply(streamShell(Buffer.from(file), 'running'))
    const a = await reg.output(WS, s)
    expect(a.output).toBe('log line\nAuthorization: ')
    expect(a.more).toBe(false)
    expect(store.rows.get(s)!.readOffset).toBe('log line\nAuthorization: '.length)
  })

  it('the UI tail is masked whole, then its cut start is trimmed', async () => {
    const { reg, setReply } = setup({}, [SECRET])
    const s = await startedShell(reg, setReply)
    const shown = SECRET.slice(5) + '\nok ' + SECRET + '\n'
    setReply(() => res({ stdout: status('exit:0', 99_999, shown.length, shown) }))
    const t = await reg.tail(WS, s)
    expect(t.output).toBe('\nok «redacted»\n')
    expect(t.truncated).toBe(true)
  })
})

/** A faithful stand-in for the in-container output script over a real byte stream: it honours the
 *  command's offset / max, and answers in the encoding the command asks for (raw bytes decoded as
 *  UTF-8 the way the docker CLI's buffer does, or base64 when the command pipes through it). */
function streamShell(bytes: Buffer, state: string) {
  return (command: string) => {
    const off = Number(command.match(/n=\$\(\(sz - (\d+)\)\)/)![1])
    const max = Number(command.match(/\[ "\$n" -gt (\d+) \]/)![1])
    const n = Math.max(0, Math.min(max, bytes.length - off))
    const body = bytes.subarray(off, off + n)
    return res({ stdout: status(state, bytes.length, n, n === 0 ? '' : command.includes('base64') ? body.toString('base64') : body.toString('utf8')) })
  }
}

describe('Task 3 fix round 2: bash_output over a NON-UTF-8 stream is contiguous and masked', () => {
  const SECRET = 'sk_live_Contiguous_42'
  async function readAll(bytes: Buffer, values: string[], state = 'exit:0') {
    const { reg, store, setReply } = setup({}, values)
    const s = await startedShell(reg, setReply)
    setReply(streamShell(bytes, state))
    const parts: string[] = []
    for (let i = 0; i < 20; i++) {
      const o = await reg.output(WS, s)
      parts.push(o.output)
      if (!o.more) break
    }
    return { joined: parts.join(''), offset: store.rows.get(s)!.readOffset, reads: parts.length }
  }
  // ASCII, a 3-byte "€" straddling the 32 KB edge, a secret, a lone invalid byte, a 4-byte emoji
  // near the next edge, then more text: N reads must rebuild the whole (masked) stream.
  const a = Buffer.from('A'.repeat(SHELL_OUTPUT_CHUNK - 1))
  const euro = Buffer.from('€')
  const mid = Buffer.concat([Buffer.from(' token=' + SECRET + ' '), Buffer.from([0xff]), Buffer.from(' RESTMARKER ')])
  const b = Buffer.from('B'.repeat(SHELL_OUTPUT_CHUNK - 1 - euro.length + 1 - mid.length))
  const emoji = Buffer.from('🙂')
  const tail = Buffer.from(' the end\n')
  const stream = Buffer.concat([a, euro, mid, b, emoji, tail])

  it('N reads concatenate to exactly the full masked stream (a 3-byte char on the 32 KB edge, a secret, an invalid byte, a 4-byte char)', async () => {
    const { joined, offset, reads } = await readAll(stream, [SECRET])
    expect(reads).toBeGreaterThan(2)
    expect(joined).toBe(stream.toString('utf8').split(SECRET).join('«redacted»'))
    expect(joined).toContain('RESTMARKER')
    expect(joined).not.toContain(SECRET.slice(0, 6))
    expect(offset).toBe(stream.length)
  })
  it('the same with no secrets configured', async () => {
    const { joined, offset, reads } = await readAll(stream, [])
    expect(reads).toBeGreaterThan(2)
    expect(joined).toBe(stream.toString('utf8'))
    expect(offset).toBe(stream.length)
  })
})

describe('final review I2: liveness refresh (the minute tick)', () => {
  it('a shell that exited unread is recorded as exited; a running one is left; peek never execs through the manager', async () => {
    const store = memShells()
    const peeks: string[] = []
    const execs: string[] = []
    let reply = (cmd: string) => res({ stdout: cmd.includes('A-SHELL') ? status('exit:0', 3, 0) : status('running', 3, 0) })
    const reg = createShellRegistry({
      exec: async (_id, command) => { execs.push(command); return res() },
      peek: async (_id, command) => { peeks.push(command); return reply(command) },
      workspace: async () => ({ id: WS, state: 'running', tainted: false, deletedAt: null }) as WorkspaceRow,
      store, secretValues: async () => [], log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    const a = (await store.create(WS, 'npm run build'))!
    const b = (await store.create(WS, 'sleep 1000'))!
    reply = (cmd: string) => res({ stdout: cmd.includes(a.id) ? status('exit:0', 3, 0) : status('running', 3, 0) })
    expect(await reg.refresh(WS)).toBe(1)
    expect(store.rows.get(a.id)).toMatchObject({ state: 'exited', exitCode: 0 })
    expect(store.rows.get(b.id)!.state).toBe('running')
    expect(peeks).toHaveLength(2)
    expect(execs).toEqual([])
    // A gone workspace (peek → null) refreshes nothing.
    const reg2 = createShellRegistry({ exec: async () => res(), peek: async () => null, workspace: async () => null, store, secretValues: async () => [] })
    expect(await reg2.refresh(WS)).toBe(0)
    expect(store.rows.get(b.id)!.state).toBe('running')
  })
})

describe('follow-up N8: the teardown kill goes through peek', () => {
  it('killAll({ noStart }) kills through peek (never the model exec) — the rows are recorded even when peek finds nothing', async () => {
    const store = memShells()
    const execs: string[] = []
    let peeks = 0
    const reg = createShellRegistry({
      exec: async (_id, command) => { execs.push(command); return res() },
      peek: async () => { peeks++; return null }, // the workspace is gone
      workspace: async () => ({ id: WS, state: 'running', tainted: false, deletedAt: null }) as WorkspaceRow,
      store, secretValues: async () => [], log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    const a = (await store.create(WS, 'python -m http.server'))!
    expect(await reg.killAll(WS, 'killed: its workstream has ended', { noStart: true })).toBe(1)
    expect(execs).toEqual([])
    expect(peeks).toBe(1)
    expect(store.rows.get(a.id)).toMatchObject({ state: 'killed', reason: 'killed: its workstream has ended' })
  })
})
