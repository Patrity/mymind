// Cycle 86 Task 1 — the host runtime: the sandbox-exec profile, the process runner (process groups,
// timeouts, aborts, caps), the eval spawn fence, and — on macOS only — REAL confinement: a confined
// command can't reach a loopback TCP listener nor write outside its workspace, a clean one can.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confinementProfile, MACH_DENY, sbplString } from './profile'
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
    expect(lines.slice(0, 5)).toEqual(['(version 1)', '(allow default)', '(deny network*)', '(deny user-preference-write)', '(deny appleevent-send)'])
    expect(p).toContain('(global-name-regex #"^com\\.apple\\.coreservices\\.")')
    expect(p).toContain('(global-name-regex #"^com\\.apple\\.lsd\\.")')
    expect(p).toContain('(global-name "com.apple.dnssd.service")')
    expect(p).toContain('(global-name "com.apple.SecurityServer")')
    expect(p).toContain(`(deny mach-lookup ${MACH_DENY.join(' ')})`)
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/shortcuts"))')
    // The allow follows its deny (sandbox-exec: the last matching rule wins), trailing slash trimmed.
    expect(lines.indexOf('(deny file-write*)')).toBeLessThan(lines.findIndex(l => l.startsWith('(allow file-write*')))
    expect(lines.at(-1)).toMatch(/^\(allow file-write\* \(subpath "\/w\/ws"\) \(subpath "\/w\/tmp"\) \(literal "\/dev\/null"\)/)
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
    for (const n of ['PATH', 'HOME', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'BASH_ENV', 'TMPDIR', '1X', 'a-b',
      'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH', 'SHELLOPTS']) expect(() => assertSecretName(n), n).toThrow(/invalid sandbox secret name/)
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

// ── fix round 1: out-of-process escapes and credential reads (macOS) ──────────────────────────

describe.runIf(darwin)('fix rounds 1–2: what an eval-world command can not reach (real sandbox-exec probes)', () => {
  const run = (command: string, confined: boolean, extra: Partial<HostCommand> = {}) =>
    runHost({ ...base(), env: confined ? confinedEnv(hostBaseEnv(), tmp) : hostBaseEnv(), ...(confined ? { confine: { writable: [ws, tmp] } } : {}), command, ...extra })

  it('mach services that act for the caller (keychain, LaunchServices, pasteboard, DNS-SD, URL sessions, Messages, AirDrop, Shortcuts) can not be looked up', async () => {
    const lookup = path.join(root, 'look.py')
    await writeFile(lookup, ['import ctypes, sys', 'lib = ctypes.CDLL("/usr/lib/libSystem.dylib")', 'bp = ctypes.c_uint.in_dll(lib, "bootstrap_port")',
      'for n in sys.argv[1:]:', '    port = ctypes.c_uint(0)', '    print(n, lib.bootstrap_look_up(bp, n.encode(), ctypes.byref(port)))'].join('\n'))
    const names = ['com.apple.coreservices.launchservicesd', 'com.apple.coreservices.quarantine-resolver', 'com.apple.lsd.mapdb', 'com.apple.dnssd.service', 'com.apple.nsurlsessiond', 'com.apple.pasteboard.1', 'com.apple.SecurityServer',
      'com.apple.securityd.xpc', 'com.apple.imagent.desktop.auth', 'com.apple.imtransferservices.IMTransferAgent', 'com.apple.sharingd', 'com.apple.shortcuts.systemshortcutservice.runner', 'com.apple.siriactionsd.xpc']
    const parse = (out: string) => Object.fromEntries(out.trim().split('\n').map(l => l.split(' ')).map(([n, r]) => [n, Number(r)]))
    const clean = parse((await run(`python3 -I ${lookup} ${names.join(' ')}`, false)).stdout)
    const present = names.filter(n => clean[n] === 0) // a service this Mac does not run proves nothing
    expect(present.length).toBeGreaterThanOrEqual(8)
    const confined = parse((await run(`python3 -I ${lookup} ${present.join(' ')}`, true)).stdout)
    for (const n of present) expect(confined[n], n).toBe(1100) // BOOTSTRAP_UNKNOWN_SERVICE: the sandbox hides it
  })

  it('the keychain: a credential stored for git is readable clean, refused confined (securityd is out of reach)', async () => {
    const helper = path.join((await runHost({ ...base(), command: 'git --exec-path' })).stdout.trim(), 'git-credential-osxkeychain')
    const id = `protocol=https\nhost=mm-host-test-${process.pid}.invalid\nusername=mmprobe\n`
    await runHost({ ...base(), command: `${helper} store`, input: `${id}password=probe-secret-${process.pid}\n\n` })
    try {
      expect((await run(`${helper} get`, false, { input: `${id}\n` })).stdout).toContain(`password=probe-secret-${process.pid}`)
      const c = await run(`${helper} get`, true, { input: `${id}\n` })
      expect(c.stdout).not.toContain('probe-secret')
      expect(c.code).not.toBe(0)
    } finally { await runHost({ ...base(), command: `${helper} erase`, input: `${id}\n` }) }
  })

  it('no preference writes through cfprefsd (`defaults write` persists nothing)', async () => {
    const domain = `mm.host.test.${process.pid}`
    try {
      const r = await run(`defaults write ${domain} k v; echo "rc=$?"`, true)
      expect(r.stdout).toMatch(/rc=[1-9]/)
      await expect(readFile(path.join(os.homedir(), 'Library/Preferences', `${domain}.plist`))).rejects.toThrow(/ENOENT/)
    } finally { await runHost({ ...base(), command: `defaults delete ${domain} >/dev/null 2>&1; rm -f ~/Library/Preferences/${domain}.plist` }) }
  })

  it('/usr/bin/shortcuts can not even start (nothing of Tony\'s is run: the exec itself is refused)', async () => {
    const r = await run('/usr/bin/shortcuts list >/dev/null 2>&1; echo "rc=$?"', true)
    expect(r.stdout).toBe('rc=126\n')
  })

  it('AF_UNIX sockets are network too: a local socket server is reachable clean, refused confined', async () => {
    const sock = path.join(root, 's.sock')
    let accepted = 0
    const server = net.createServer((c) => { accepted++; c.end('hi') })
    await new Promise<void>(r => server.listen(sock, () => r()))
    try {
      const probe = `python3 -I -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(2).decode())' ${sock}`
      expect((await run(probe, false)).stdout).toBe('hi\n')
      const c = await run(probe, true)
      expect(c.code).not.toBe(0)
      expect(c.stderr).toMatch(/Operation not permitted|PermissionError/)
      expect(accepted).toBe(1)
    } finally { await new Promise(r => server.close(r)) }
  })

  it('appleevent-send (probed alone, so no real event is ever sent): an event to Finder is refused as if Finder were not running', async () => {
    // The full profile already refuses /usr/bin/osascript itself, and a copy of it is killed by
    // macOS launch constraints — so the Apple-event rule is probed on its own here (the profile
    // test above pins that the real profile carries it).
    const r = await runHost({ ...base(), command: `/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny appleevent-send)' /usr/bin/osascript -e 'tell application "Finder" to count windows'` })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/-600/)
  })

  it('LaunchServices: LSOpenCFURLRef can not hand a URL to the browser — a loopback listener never sees the request', async () => {
    // Re-review I4: denying launchservicesd alone left LSOpen working (the browser fetched the URL,
    // with whatever data it carried). Only the clean case would launch a browser, so it is never run.
    const lsopen = path.join(root, 'lsopen.py')
    await writeFile(lsopen, [
      'import ctypes, sys',
      'cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")',
      'cs = ctypes.CDLL("/System/Library/Frameworks/CoreServices.framework/CoreServices")',
      'cf.CFURLCreateWithBytes.restype = ctypes.c_void_p',
      'cf.CFURLCreateWithBytes.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32, ctypes.c_void_p]',
      'cs.LSOpenCFURLRef.argtypes = [ctypes.c_void_p, ctypes.c_void_p]',
      'u = sys.argv[1].encode()',
      'print("ls=%d" % cs.LSOpenCFURLRef(cf.CFURLCreateWithBytes(None, u, len(u), 0x08000100, None), None))'
    ].join('\n'))
    const seen: string[] = []
    const server = net.createServer((c) => { c.on('error', () => {}); c.on('data', d => seen.push(d.toString().split('\r\n')[0]!)); c.end('HTTP/1.1 204 No Content\r\n\r\n') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as net.AddressInfo).port
      const r = await run(`python3 -I ${lsopen} 'http://127.0.0.1:${port}/?leak=MM_LSOPEN_PROBE'`, true)
      expect(r.stdout).toMatch(/^ls=-?\d+\n$/)
      expect(r.stdout).not.toBe('ls=0\n')
      await sleep(3000) // a browser would have fetched by now
      expect(seen).toEqual([])
    } finally { await new Promise(r => server.close(r)) }
  }, 20_000)
})
