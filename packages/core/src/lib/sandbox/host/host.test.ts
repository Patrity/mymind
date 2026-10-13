// Cycle 86 Task 1 — the host runtime: the sandbox-exec profile, the process runner (process groups,
// timeouts, aborts, caps), the eval spawn fence, and — on macOS only — REAL confinement: a confined
// command can't reach a loopback TCP listener nor write outside its workspace, a clean one can.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confinementProfile, sbplString } from './profile'
import { assertEvalSpawn, registerEvalScratch, runHost, unregisterEvalScratch, type HostCommand } from './spawn'
import { assertSecretName, confinedEnv, hostBaseEnv } from './env'

const darwin = process.platform === 'darwin'
let root: string
let ws: string
let tmp: string
let outside: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-host-')))
  ws = path.join(root, 'ws'); tmp = path.join(root, 'tmp'); outside = path.join(root, 'outside')
  for (const d of [ws, tmp, outside]) await mkdir(d)
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const base = () => ({ cwd: ws, env: hostBaseEnv(), timeoutMs: 20_000, capBytes: 64 * 1024 })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the sandbox-exec profile', () => {
  it('denies network, writes everywhere but the workspace + tmp, Apple events, LaunchServices/pasteboard/DNS-SD, open/osascript — allows LAST', () => {
    const p = confinementProfile({ writable: ['/w/ws', '/w/tmp/'] })
    const lines = p.split('\n')
    expect(lines.slice(0, 3)).toEqual(['(version 1)', '(allow default)', '(deny network*)'])
    expect(p).toContain('(deny appleevent-send)')
    expect(p).toContain('(global-name "com.apple.coreservices.launchservicesd")')
    expect(p).toContain('(global-name "com.apple.dnssd.service")')
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))')
    // The allow follows its deny (sandbox-exec: the last matching rule wins), trailing slash trimmed.
    expect(lines.indexOf('(deny file-write*)')).toBeLessThan(lines.findIndex(l => l.startsWith('(allow file-write*')))
    expect(lines.at(-1)).toMatch(/^\(allow file-write\* \(subpath "\/w\/ws"\) \(subpath "\/w\/tmp"\) \(literal "\/dev\/null"\)/)
    expect(p).not.toContain('file-read*')
  })

  it('eval: reads under the home dir denied, the world dir allowed after it', () => {
    const p = confinementProfile({ writable: ['/h/x/w'], denyReadUnder: '/h', readable: ['/h/x'] }).split('\n')
    expect(p.at(-2)).toBe('(deny file-read* (subpath "/h"))')
    expect(p.at(-1)).toBe('(allow file-read* (subpath "/h/x"))')
  })

  it('a path can never end the literal and add a rule; relative paths and an empty allow-list are refused', () => {
    expect(() => sbplString('/x") (allow network*) ("')).toThrow(/unsafe path/)
    expect(() => sbplString('/x\n(allow network*)')).toThrow(/unsafe path/)
    expect(() => confinementProfile({ writable: ['relative'] })).toThrow(/absolute/)
    expect(() => confinementProfile({ writable: [] })).toThrow(/writable/)
  })
})

describe('the env', () => {
  it('a command never inherits the worker env (DATABASE_URL, API keys); confined drops the ssh agent and gets its own TMPDIR', () => {
    const env = hostBaseEnv({ HOME: '/Users/b', USER: 'b', DATABASE_URL: 'postgres://secret', OPENAI_API_KEY: 'sk', SSH_AUTH_SOCK: '/tmp/agent' })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'SSH_AUTH_SOCK', 'TERM', 'USER'])
    expect(env.PATH).toMatch(/^\/Users\/b\/\.local\/bin:\/opt\/homebrew\/bin:/)
    const c = confinedEnv(env, '/t')
    expect(c.SSH_AUTH_SOCK).toBeUndefined()
    expect(c.TMPDIR).toBe('/t')
  })
  it('reserved secret names are refused', () => {
    for (const n of ['PATH', 'HOME', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'BASH_ENV', 'TMPDIR', '1X', 'a-b']) expect(() => assertSecretName(n), n).toThrow(/invalid sandbox secret name/)
    expect(() => assertSecretName('GITHUB_TOKEN')).not.toThrow()
  })
})

describe('runHost (real processes)', () => {
  it('runs bash in the cwd with stdin; exit code and both streams', async () => {
    const r = await runHost({ ...base(), command: 'pwd; cat; echo err >&2; exit 3', input: 'from-stdin' })
    expect(r).toMatchObject({ code: 3, timedOut: false, aborted: false, truncated: false })
    expect(r.stdout).toBe(`${ws}\nfrom-stdin`)
    expect(r.stderr).toBe('err\n')
  })

  it('keeps the TAIL of a long output and says it was cut', async () => {
    const r = await runHost({ ...base(), capBytes: 1024, command: 'for i in $(seq 1 2000); do echo "line $i"; done' })
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024)
    expect(r.stdout.endsWith('line 2000\n')).toBe(true)
  })

  it('a timeout kills the WHOLE process group — no child survives, not even one that ignores SIGTERM', async () => {
    const r = await runHost({ ...base(), timeoutMs: 500, command: 'sleep 30 & echo "child=$!"; (trap "" TERM; exec sleep 30) & echo "stubborn=$!"; sleep 30' })
    expect(r.timedOut).toBe(true)
    const child = Number(r.stdout.match(/child=(\d+)/)![1])
    const stubborn = Number(r.stdout.match(/stubborn=(\d+)/)![1])
    await sleep(2800) // SIGTERM, then SIGKILL after 2 s
    expect(alive(child)).toBe(false)
    expect(alive(stubborn)).toBe(false)
  })

  it('an abort kills the group at once', async () => {
    const ac = new AbortController()
    const p = runHost({ ...base(), signal: ac.signal, command: 'sleep 30 & echo "child=$!"; sleep 30' })
    await sleep(300)
    ac.abort()
    const r = await p
    expect(r.aborted).toBe(true)
    const child = Number(r.stdout.match(/child=(\d+)/)![1])
    await sleep(100)
    expect(alive(child)).toBe(false)
  })

  it('a clean command\'s `cmd &` outlives it (Bridget\'s choice); reapGroup kills it', async () => {
    const free = await runHost({ ...base(), command: 'sleep 20 >/dev/null 2>&1 & echo $!' })
    const kept = Number(free.stdout.trim())
    expect(alive(kept)).toBe(true)
    process.kill(kept, 'SIGKILL')
    const reaped = await runHost({ ...base(), reapGroup: true, command: 'sleep 20 >/dev/null 2>&1 & echo $!' })
    const gone = Number(reaped.stdout.trim())
    await sleep(100)
    expect(alive(gone)).toBe(false)
  })
})

describe('the eval spawn fence', () => {
  const WORLD = 'eval_00000000000040008000000000000a1_00000001'
  const scope = { worldId: WORLD }
  const home = os.homedir()
  let wr: string
  beforeAll(async () => {
    wr = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-world-')))
    registerEvalScratch(WORLD, wr)
  })
  afterAll(async () => { unregisterEvalScratch(WORLD); await rm(wr, { recursive: true, force: true }) })
  const good = (): HostCommand => ({
    command: 'ls', cwd: `${wr}/11111111-1111-1111-1111-111111111111`, timeoutMs: 1000, capBytes: 1024,
    env: { HOME: `${wr}/.home`, PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: `${wr}/.tmp/mm-1`, USER: 'b', LOGNAME: 'b', SHELL: '/bin/bash', TERM: 'dumb' },
    confine: { writable: [`${wr}/11111111-1111-1111-1111-111111111111`, `${wr}/.tmp/mm-1`], denyReadUnder: home, readable: [wr] }
  })

  it('the manager\'s own shape passes', () => {
    expect(() => assertEvalSpawn(good(), scope)).not.toThrow()
  })

  it('refuses every escape before anything runs', () => {
    const probes: Array<[string, (c: HostCommand) => HostCommand]> = [
      ['unconfined', ({ confine: _c, ...c }) => c],
      ['cwd elsewhere', c => ({ ...c, cwd: '/Users' })],
      ['cwd escaping with ..', c => ({ ...c, cwd: `${wr}/../x` })],
      ['another world\'s dir', c => ({ ...c, cwd: `${wr}-other/w` })],
      ['writable elsewhere', c => ({ ...c, confine: { ...c.confine!, writable: [...c.confine!.writable, home] } })],
      ['writable /', c => ({ ...c, confine: { ...c.confine!, writable: ['/'] } })],
      ['home reads allowed', c => ({ ...c, confine: { ...c.confine!, denyReadUnder: undefined } })],
      ['reads allowed elsewhere', c => ({ ...c, confine: { ...c.confine!, readable: [home] } })],
      ['a secret in the env', c => ({ ...c, env: { ...c.env, GITHUB_TOKEN: 'x' } })],
      ['the worker\'s database URL', c => ({ ...c, env: { ...c.env, DATABASE_URL: 'postgres://x' } })],
      ['HOME outside', c => ({ ...c, env: { ...c.env, HOME: home } })],
      ['TMPDIR outside', c => ({ ...c, env: { ...c.env, TMPDIR: '/tmp' } })]
    ]
    for (const [why, f] of probes) expect(() => assertEvalSpawn(f(good()), scope), why).toThrow(/refused in an eval world/)
  })

  it('a world with no registered scratch dir runs nothing', () => {
    expect(() => assertEvalSpawn(good(), { worldId: 'eval_00000000000040008000000000000a1_00000009' })).toThrow(/no scratch dir registered/)
  })
})

// ── real confinement (macOS sandbox-exec) ─────────────────────────────────────────────────────

describe.runIf(darwin)('confinement under sandbox-exec (macOS)', () => {
  let server: net.Server
  let port = 0
  let accepted = 0
  beforeAll(async () => {
    server = net.createServer((s) => { accepted++; s.end('hello') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(async () => { await new Promise(r => server.close(r)) })

  const connect = () => `python3 -I -c 'import socket,sys; s=socket.create_connection(("127.0.0.1", int(sys.argv[1])), 3); print(s.recv(5).decode())' ${port}`
  const confine = () => ({ writable: [ws, tmp] })

  it('a CLEAN command reaches a loopback listener; a CONFINED one is refused', async () => {
    const before = accepted
    const clean = await runHost({ ...base(), command: connect() })
    expect(clean).toMatchObject({ code: 0, stdout: 'hello\n' })
    expect(accepted).toBe(before + 1)
    const confined = await runHost({ ...base(), confine: confine(), command: connect() })
    expect(confined.code).not.toBe(0)
    expect(confined.stderr).toMatch(/Operation not permitted|PermissionError/)
    expect(accepted).toBe(before + 1) // the listener never saw it
  })

  it('a CONFINED command writes inside the workspace and its tmp dir, never outside; a CLEAN one writes anywhere', async () => {
    const target = path.join(outside, 'x.txt')
    const confined = await runHost({ ...base(), env: confinedEnv(hostBaseEnv(), tmp), confine: confine(), command: `echo in > inside.txt && echo t > "$TMPDIR/t.txt" && echo out > ${JSON.stringify(target)}` })
    expect(confined.code).not.toBe(0)
    expect(confined.stderr).toMatch(/Operation not permitted/)
    expect(await readFile(path.join(ws, 'inside.txt'), 'utf8')).toBe('in\n')
    expect(await readFile(path.join(tmp, 't.txt'), 'utf8')).toBe('t\n')
    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/)
    const clean = await runHost({ ...base(), command: `echo out > ${JSON.stringify(target)}` })
    expect(clean.code).toBe(0)
    expect(await readFile(target, 'utf8')).toBe('out\n')
  })

  it('a confined command can\'t hand a URL to LaunchServices (`open`) or script another app', async () => {
    const r = await runHost({ ...base(), confine: confine(), command: '/usr/bin/open -g https://example.invalid/; echo "open=$?"; /usr/bin/osascript -e "return 1"; echo "osa=$?"' })
    expect(r.stdout).toMatch(/open=(?!0)\d+/)
    expect(r.stdout).toMatch(/osa=(?!0)\d+/)
  })

  it('eval shape: reads under the home dir are denied except the world dir', async () => {
    const homeFile = path.join(os.homedir(), `.mm-host-test-${process.pid}`)
    await writeFile(homeFile, 'tony')
    try {
      const r = await runHost({ ...base(), confine: { writable: [ws], denyReadUnder: os.homedir(), readable: [root] }, command: `cat ${JSON.stringify(homeFile)}; echo "home=$?"; cat inside.txt; echo "ws=$?"` })
      expect(r.stdout).toMatch(/home=(?!0)\d+/)
      expect(r.stdout).toContain('ws=0')
    } finally { await rm(homeFile, { force: true }) }
  })
})
