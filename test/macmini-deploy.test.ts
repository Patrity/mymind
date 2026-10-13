// Cycle 86 Task 3: the Mac mini deploy — deploy/macmini/release.sh (stage/activate/rollback symlink
// swaps, prune, the darwin-native and load checks), deploy/macmini/run.sh (the launchd wrapper: env,
// heap caps, worker-only vars, log rotation), the plists, and deploy.yml's shape. Everything runs
// against a temp root; nothing touches launchctl or ~/mymind.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const RELEASE = resolve('deploy/macmini/release.sh')
const RUN = resolve('deploy/macmini/run.sh')

let root: string
let src: string
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'mymind-release-'))
  root = join(base, 'mymind')
  src = join(base, 'src')
  mkdirSync(root)
})
afterEach(() => { rmSync(dirname(root), { recursive: true, force: true }) })

type Files = Record<string, string>
function writeTree(dir: string, files: Files) {
  rmSync(dir, { recursive: true, force: true })
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  mkdirSync(dir, { recursive: true })
}
const WEB: Files = { '.output/server/index.mjs': 'export {}\n' }
const WORKER: Files = { 'dist/worker.mjs': 'export {}\n' }

function release(args: string[], input?: Buffer) {
  const r = spawnSync('bash', [RELEASE, ...args], {
    input,
    env: { ...process.env, MYMIND_ROOT: root, MYMIND_NODE: process.execPath },
    encoding: 'utf8'
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
function stage(kind: 'web' | 'worker', id: string, files: Files) {
  writeTree(src, files)
  return release(['stage', kind, id], execFileSync('tar', ['-c', '-C', src, '.'], { maxBuffer: 256 * 1024 * 1024 }))
}
/** Where a pointer points: the release name, null when absent. Asserts it is a symlink. */
function ptr(name: string): string | null {
  const p = join(root, name)
  try { lstatSync(p) } catch { return null }
  expect(lstatSync(p).isSymbolicLink()).toBe(true)
  return readlinkSync(p).replace(/^releases\//, '')
}
const releases = () => readdirSync(join(root, 'releases')).sort()

describe('release.sh stage', () => {
  it('unpacks into releases/<kind>-<id> and points only the next pointer at it', () => {
    const r = stage('web', 'a', WEB)
    expect(r.code, r.out).toBe(0)
    expect(ptr('.app-next')).toBe('web-a')
    expect(ptr('app')).toBeNull()
    expect(existsSync(join(root, 'releases/web-a/.output/server/index.mjs'))).toBe(true)
  })

  it('refuses a release without its entry file and leaves no trace', () => {
    const r = stage('worker', 'a', { 'dist/other.mjs': '' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no dist/worker.mjs')
    expect(ptr('.worker-next')).toBeNull()
    expect(releases()).toEqual([])
  })

  it('refuses a linux native package without its darwin-arm64 twin (pnpm store layout)', () => {
    const files = { ...WORKER, 'node_modules/.pnpm/@img+sharp-linux-x64@0.34.5/node_modules/@img/sharp-linux-x64/package.json': '{}' }
    const r = stage('worker', 'a', files)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no darwin-arm64 twin for node_modules/.pnpm/@img+sharp-linux-x64@0.34.5')
    expect(releases()).toEqual([])
    const ok = stage('worker', 'a', {
      ...files,
      'node_modules/.pnpm/@img+sharp-darwin-arm64@0.34.5/node_modules/@img/sharp-darwin-arm64/package.json': '{}',
      'node_modules/.pnpm/@napi-rs+canvas-linux-x64-gnu@0.1.100/node_modules/@napi-rs/canvas-linux-x64-gnu/package.json': '{}',
      'node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@0.1.100/node_modules/@napi-rs/canvas-darwin-arm64/package.json': '{}'
    })
    expect(ok.code, ok.out).toBe(0)
  })

  it('refuses a web release whose flat @img dir has only the linux build', () => {
    const r = stage('web', 'a', { ...WEB, '.output/server/node_modules/@img/sharp-libvips-linux-x64/package.json': '{}' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no darwin-arm64 twin for .output/server/node_modules/@img/sharp-libvips-linux-x64')
  })

  it('refuses a worker release whose externals do not load here', () => {
    const r = stage('worker', 'a', { ...WORKER, 'node_modules/bad/package.json': '{"name":"bad","main":"index.js"}', 'node_modules/bad/index.js': 'throw new Error("no binary for this platform")\n' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("the worker's externals do not load: bad")
    expect(releases()).toEqual([])
    const ok = stage('worker', 'a', { ...WORKER, 'node_modules/good/package.json': '{"name":"good","main":"index.js"}', 'node_modules/good/index.js': 'module.exports = 1\n' })
    expect(ok.code, ok.out).toBe(0)
    expect(existsSync(join(root, 'releases/worker-a/dist/.verify-externals.mjs'))).toBe(false)
  })

  it('refuses a web release whose sharp does not load here', () => {
    const sharp = (body: string) => ({ ...WEB, '.output/server/node_modules/sharp/package.json': '{"name":"sharp","main":"index.js"}', '.output/server/node_modules/sharp/index.js': body })
    const r = stage('web', 'a', sharp('throw new Error("Could not load the sharp module")\n'))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('sharp does not load from the web release')
    expect(stage('web', 'a', sharp('module.exports = () => {}\n')).code).toBe(0)
  })

  it('never overwrites a release a pointer uses when the same id is staged again', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    const r = stage('web', 'a', WEB)
    expect(r.code, r.out).toBe(0)
    expect(ptr('app')).toBe('web-a')
    expect(ptr('.app-next')).toMatch(/^web-a\.\d+$/)
  })

  it('rejects ids that would escape releases/', () => {
    expect(stage('web', '../x', WEB).code).not.toBe(0)
    expect(stage('web', '.hidden', WEB).code).not.toBe(0)
  })
})

describe('release.sh activate / rollback', () => {
  it('first activate: current ← next, no prev', () => {
    stage('web', 'a', WEB)
    const r = release(['activate', 'web'])
    expect(r.code, r.out).toBe(0)
    expect([ptr('app'), ptr('.app-prev'), ptr('.app-next')]).toEqual(['web-a', null, null])
  })

  it('second activate keeps the old current as prev; rollback swaps them back and parks the bad one in next', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    stage('web', 'b', WEB); release(['activate', 'web'])
    expect([ptr('app'), ptr('.app-prev'), ptr('.app-next')]).toEqual(['web-b', 'web-a', null])

    const r = release(['rollback', 'web'])
    expect(r.code, r.out).toBe(0)
    expect([ptr('app'), ptr('.app-prev'), ptr('.app-next')]).toEqual(['web-a', null, 'web-b'])
    // A second rollback has nothing to go back to and changes nothing.
    expect(release(['rollback', 'web']).code).not.toBe(0)
    expect([ptr('app'), ptr('.app-prev'), ptr('.app-next')]).toEqual(['web-a', null, 'web-b'])
  })

  it('activate without a staged release fails and leaves current alone', () => {
    stage('worker', 'a', WORKER); release(['activate', 'worker'])
    const r = release(['activate', 'worker'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no staged worker release')
    expect(ptr('.worker')).toBe('worker-a')
  })

  it('prunes releases no pointer references, across both kinds', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    stage('worker', 'a', WORKER); release(['activate', 'worker'])
    stage('web', 'b', WEB); release(['activate', 'web'])
    stage('web', 'c', WEB); release(['activate', 'web'])
    expect(releases()).toEqual(['web-b', 'web-c', 'worker-a'])
    expect([ptr('app'), ptr('.app-prev'), ptr('.worker')]).toEqual(['web-c', 'web-b', 'worker-a'])
  })

  it('swaps by rename: no stray temp links, and a real directory at a pointer path is refused', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    stage('web', 'b', WEB); release(['activate', 'web'])
    expect(readdirSync(root).filter(f => f.includes('.swap.'))).toEqual([])

    rmSync(join(root, 'app')); mkdirSync(join(root, 'app'))
    stage('web', 'c', WEB)
    const r = release(['activate', 'web'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('is a real directory')
  })

  it('final wave N3: status is "<pointer> <release>" per line — exactly what CD\'s STAGED_* awk reads', () => {
    stage('web', 'a', WEB); release(['activate', 'web']); stage('web', 'b', WEB)
    stage('worker', 'z', WORKER)
    const out = release(['status']).out
    expect(out.split('\n').filter(Boolean)).toEqual([
      'app           web-a',
      '.app-prev     -',
      '.app-next     web-b',
      '.worker       -',
      '.worker-prev  -',
      '.worker-next  worker-z'
    ])
    const wf = readFileSync('.github/workflows/deploy.yml', 'utf8')
    for (const [ptrName, want] of [['.app-next', 'web-b'], ['.worker-next', 'worker-z']] as const) {
      const prog = wf.match(new RegExp(`awk '(\\$1 == "${ptrName.replace('.', '\\.')}" \\{ print \\$2 \\})'`))![1]!
      expect(execFileSync('awk', [prog], { input: out, encoding: 'utf8' }).trim()).toBe(want)
    }
  })

  it('status prints each pointer', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    stage('worker', 'z', WORKER)
    const out = release(['status']).out
    expect(out).toMatch(/^app\s+web-a$/m)
    expect(out).toMatch(/^\.worker-next\s+worker-z$/m)
    expect(out).toMatch(/^\.worker\s+-$/m)
  })
})

describe('release.sh native dlopen check', () => {
  it('refuses a release whose darwin *.node binary does not load (worker and web)', () => {
    const bad = 'not a mach-o binary'
    const w = stage('worker', 'a', { ...WORKER, 'node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@0.1.100/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node': bad })
    expect(w.code).not.toBe(0)
    expect(w.out).toContain('native binary does not load: node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@0.1.100/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node')
    expect(releases()).toEqual([])
    const web = stage('web', 'a', { ...WEB, '.output/server/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node': bad })
    expect(web.code).not.toBe(0)
    expect(web.out).toContain('native binary does not load: .output/server/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node')
  })

  const realNode = (() => {
    try { return execFileSync('bash', ['-c', 'ls node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@*/node_modules/@napi-rs/canvas-darwin-arm64/*.node | head -1'], { encoding: 'utf8' }).trim() } catch { return '' }
  })()
  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64' || !realNode)('accepts a release whose darwin binary really loads', () => {
    const r = stage('worker', 'a', { ...WORKER, 'node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@0.1.100/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node': readFileSync(realNode) as unknown as string })
    expect(r.code, r.out).toBe(0)
  })
})

describe('release.sh restart / health / undo (fake launchctl + psql)', () => {
  let fake: string
  let bin: string
  beforeEach(() => {
    fake = join(dirname(root), 'lc'); bin = join(dirname(root), 'bin')
    mkdirSync(fake); mkdirSync(bin)
    // State: <label>.pid = loaded with that pid. `unload-in` = prints left before a bootout completes;
    // `fail-bootstrap` = bootstraps to fail with launchd's error 5 first; `stuck` = kickstart never respawns.
    writeFileSync(join(bin, 'launchctl'), `#!/bin/bash
S="$FAKE_LC"; echo "$*" >> "$S/calls"
label() { basename "$1" .plist | sed 's#.*/##'; }
case "$1" in
  print)
    l=$(label "$2")
    if [ -f "$S/$l.unloading" ]; then n=$(cat "$S/$l.unloading"); if [ "$n" -le 0 ]; then rm -f "$S/$l.unloading" "$S/$l.pid"; else echo $((n-1)) > "$S/$l.unloading"; fi; fi
    [ -f "$S/$l.pid" ] || exit 113; echo "	pid = $(cat "$S/$l.pid")" ;;
  kickstart) l=$(label "$3"); [ -f "$S/stuck" ] || echo $(( $(cat "$S/$l.pid") + 1 )) > "$S/$l.pid" ;;
  bootout) l=$(label "$2"); echo "\${UNLOAD_IN:-0}" > "$S/$l.unloading" ;;
  bootstrap)
    l=$(label "$3")
    if [ -f "$S/$l.pid" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    if [ -s "$S/fail-bootstrap" ] && [ "$(cat "$S/fail-bootstrap")" -gt 0 ]; then echo $(( $(cat "$S/fail-bootstrap") - 1 )) > "$S/fail-bootstrap"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo 900 > "$S/$l.pid"; cp "$3" "$S/$l.bootstrapped" ;;
esac
`, { mode: 0o755 })
    // Answers 1 only for the query shape health must send: this pid, a started_at bound, a fresh beat.
    writeFileSync(join(bin, 'psql'), `#!/bin/bash
q="\${@: -1}"; echo "$q" > "$FAKE_LC/sql"
case "$q" in *"pid = $HEALTHY_PID "*"started_at > now() - interval '"*" seconds' and beat_at > now() - interval '30 seconds'"*) echo 1 ;; *) echo 0 ;; esac
`, { mode: 0o755 })
    writeFileSync(join(dirname(root), 'mymind.env'), 'DATABASE_URL=postgres://u:secret@192.168.2.80/bridget\n')
    mkdirSync(join(root, 'agents'))
    writeFileSync(join(root, 'agents/com.mymind.worker.plist'), 'v1')
  })
  function rel(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('bash', [RELEASE, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LC: fake, MYMIND_ROOT: root, MYMIND_NODE: process.execPath,
        MYMIND_PSQL: join(bin, 'psql'), MYMIND_ENV_FILE: join(dirname(root), 'mymind.env'), MYMIND_LAUNCH_AGENTS: join(root, 'agents'),
        MYMIND_PENDING_AGENTS: join(root, 'pending'), MYMIND_POLL_SECONDS: '0', MYMIND_RESTART_WAIT: '3', ...env },
      encoding: 'utf8'
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const pid = () => readFileSync(join(fake, 'com.mymind.worker.pid'), 'utf8').trim()
  const calls = () => readFileSync(join(fake, 'calls'), 'utf8')

  it('restart of a loaded agent kickstarts it and returns once launchd runs a new pid', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100')
    const r = rel(['restart', 'worker'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('running as pid 101 (was 100)')
    expect(calls()).toMatch(/^kickstart -k gui\/\d+\/com\.mymind\.worker$/m)
    expect(readFileSync(join(root, '.restarted-worker'), 'utf8')).toMatch(/^\d+ 100\n$/)
  })

  it('restart fails when no new pid appears (kickstart returned but the old process is still the one)', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100'); writeFileSync(join(fake, 'stuck'), '')
    const r = rel(['restart', 'worker'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('has no new pid')
  })

  it('a pending plist change: bootout, wait for the exit, install, bootstrap (retrying error 5)', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100')
    mkdirSync(join(root, 'pending')); writeFileSync(join(root, 'pending/com.mymind.worker.plist'), 'v2')
    writeFileSync(join(fake, 'fail-bootstrap'), '2')
    const r = rel(['restart', 'worker'], { UNLOAD_IN: '2' })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(root, 'agents/com.mymind.worker.plist'), 'utf8')).toBe('v2')
    expect(readFileSync(join(fake, 'com.mymind.worker.bootstrapped'), 'utf8')).toBe('v2')
    expect(pid()).toBe('900')
    expect(calls()).not.toContain('kickstart')
    expect(calls().match(/^bootstrap /gm)).toHaveLength(3)
  })

  it('a bootstrap that keeps failing leaves the agent unloaded and FAILS the restart', () => {
    writeFileSync(join(fake, 'fail-bootstrap'), '99')
    const r = rel(['restart', 'worker'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('bootstrap of com.mymind.worker failed (agent NOT loaded)')
  })

  it('health passes only for a new pid whose heartbeat started after the restart', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100')
    expect(rel(['restart', 'worker']).code).toBe(0)
    const ok = rel(['health', 'worker', '0'], { HEALTHY_PID: '101' })
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toContain('worker healthy (pid 101)')
    // The bound is on the DB's clock: now() minus the time elapsed since the restart (+5 s slack).
    expect(readFileSync(join(fake, 'sql'), 'utf8')).toMatch(/started_at > now\(\) - interval '([5-9]|1[0-9]) seconds'/)
    expect(ok.out).not.toContain('secret')
    // The DB says nothing fresh for this pid → red.
    expect(rel(['health', 'worker', '0'], { HEALTHY_PID: '999' }).code).not.toBe(0)
  })

  it('final wave N1: the started_at bound is the elapsed time since the restart, on the DB clock — the mini clock never leaks into SQL', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '101')
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(root, '.restarted-worker'), `${now - 120} 100\n`)
    expect(rel(['health', 'worker', '0'], { HEALTHY_PID: '101' }).code).toBe(0)
    const sql = readFileSync(join(fake, 'sql'), 'utf8')
    const ago = Number(sql.match(/started_at > now\(\) - interval '(\d+) seconds'/)![1])
    expect(ago).toBeGreaterThanOrEqual(125)
    expect(ago).toBeLessThan(135)
    expect(sql).not.toContain(String(now - 120))
    expect(sql).not.toContain('to_timestamp')
    // A restart stamp "in the future" (the mini clock stepped back) clamps to the 5 s slack.
    writeFileSync(join(root, '.restarted-worker'), `${now + 3600} 100\n`)
    expect(rel(['health', 'worker', '0'], { HEALTHY_PID: '101' }).code).toBe(0)
    expect(readFileSync(join(fake, 'sql'), 'utf8')).toContain("started_at > now() - interval '5 seconds'")
    writeFileSync(join(root, '.restarted-worker'), `1;drop 100\n`)
    expect(rel(['health', 'worker', '0'], { HEALTHY_PID: '101' }).out).toContain('malformed')
  })

  it('health never accepts the pid restart replaced, even with a fresh beat', () => {
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100')
    writeFileSync(join(root, '.restarted-worker'), `${Math.floor(Date.now() / 1000)} 100\n`)
    const r = rel(['health', 'worker', '0'], { HEALTHY_PID: '100' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no fresh heartbeat from a new worker')
  })

  it('undo rolls back + restarts only while current is exactly the given release', () => {
    stage('worker', 'a', WORKER); release(['activate', 'worker'])
    stage('worker', 'b', WORKER); release(['activate', 'worker'])
    writeFileSync(join(fake, 'com.mymind.worker.pid'), '100')
    const skip = rel(['undo', 'worker', 'worker-a'])
    expect(skip.code, skip.out).toBe(0)
    expect(skip.out).toContain('nothing to undo')
    expect(ptr('.worker')).toBe('worker-b')
    const r = rel(['undo', 'worker', 'worker-b'])
    expect(r.code, r.out).toBe(0)
    expect(ptr('.worker')).toBe('worker-a')
    expect(pid()).toBe('101')
  })
})

describe('run.sh (the launchd wrapper)', () => {
  let fakeNode: string
  let envFile: string
  let logDir: string
  beforeEach(() => {
    fakeNode = join(dirname(root), 'fake-node')
    // Prints what node would have run with — argv, cwd and the env keys under test.
    writeFileSync(fakeNode, '#!/bin/bash\necho "ARGS=$*"\necho "CWD=$PWD"\nfor k in NODE_ENV FROM_ENV_FILE AGENT_RUNTIME_EXCLUSIVE MYMIND_GIT_SHA MYMIND_EVALS_DIR; do echo "$k=${!k-<unset>}"; done\n', { mode: 0o755 })
    envFile = join(dirname(root), 'mymind.env')
    writeFileSync(envFile, 'FROM_ENV_FILE="has a space"\n')
    logDir = join(dirname(root), 'logs')
  })
  function run(kind: string, extra: Record<string, string> = {}) {
    return spawnSync('bash', [RUN, kind], {
      env: { ...process.env, MYMIND_ROOT: root, MYMIND_ENV_FILE: envFile, MYMIND_LOG_DIR: logDir, MYMIND_NODE: fakeNode, MYMIND_RUN_FAIL_SLEEP: '0', ...extra },
      encoding: 'utf8'
    })
  }
  /** The log is written by a background reader: wait for the last line the fake node prints. */
  async function logOf(kind: string): Promise<string> {
    const f = join(logDir, `${kind}.log`)
    for (let i = 0; i < 100; i++) {
      if (existsSync(f) && readFileSync(f, 'utf8').includes('MYMIND_EVALS_DIR=')) return readFileSync(f, 'utf8')
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`no complete ${kind}.log`)
  }

  it('web: env file exported, NODE_ENV=production, 1536 MB heap, cwd = the real release dir, release sha, no worker-only vars', async () => {
    stage('web', 'a', { ...WEB, 'release.env': 'MYMIND_GIT_SHA=websha\n' }); release(['activate', 'web'])
    expect(run('web').status).toBe(0)
    const log = await logOf('web')
    expect(log).toContain('ARGS=--max-old-space-size=1536 .output/server/index.mjs')
    expect(log).toContain(`CWD=${realpathSync(join(root, 'releases/web-a'))}`)
    expect(log).toContain('NODE_ENV=production')
    expect(log).toContain('FROM_ENV_FILE=has a space')
    expect(log).toContain('AGENT_RUNTIME_EXCLUSIVE=<unset>')
    expect(log).toContain('MYMIND_GIT_SHA=websha')
    expect(log).toContain('MYMIND_EVALS_DIR=<unset>')
  })

  it('worker: 2048 MB heap, AGENT_RUNTIME_EXCLUSIVE=1, release.env sha, evals dir inside the release', async () => {
    stage('worker', 'a', { ...WORKER, 'release.env': 'MYMIND_GIT_SHA=abc123\n', 'evals/x.json': '{}' }); release(['activate', 'worker'])
    expect(run('worker').status).toBe(0)
    const log = await logOf('worker')
    const rel = realpathSync(join(root, 'releases/worker-a'))
    expect(log).toContain('ARGS=--max-old-space-size=2048 dist/worker.mjs')
    expect(log).toContain(`CWD=${rel}`)
    expect(log).toContain('AGENT_RUNTIME_EXCLUSIVE=1')
    expect(log).toContain('MYMIND_GIT_SHA=abc123')
    expect(log).toContain(`MYMIND_EVALS_DIR=${rel}/evals`)
  })

  it('refuses to start without the env file or without an active release (exit 78)', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    expect(run('web', { MYMIND_ENV_FILE: join(root, 'nope.env') }).status).toBe(78)
    expect(run('worker').status).toBe(78)
    expect(run('bogus').status).toBe(64)
  })

  it('rotates the log past the size cap, keeping MYMIND_LOG_KEEP files', async () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    writeFileSync(fakeNode, '#!/bin/bash\nfor i in $(seq 1 2000); do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done\necho DONE\n', { mode: 0o755 })
    expect(run('web', { MYMIND_LOG_MAX_BYTES: '10000', MYMIND_LOG_KEEP: '2' }).status).toBe(0)
    const f = join(logDir, 'web.log')
    for (let i = 0; i < 200 && !(existsSync(f) && readFileSync(f, 'utf8').includes('DONE')); i++) await new Promise(r => setTimeout(r, 20))
    expect(readFileSync(f, 'utf8')).toContain('DONE')
    expect(readdirSync(logDir).sort()).toEqual(['web.log', 'web.log.1', 'web.log.2'])
    expect(readFileSync(join(logDir, 'web.log.1'), 'utf8').length).toBeGreaterThan(10000)
  })
})

describe('launchd plists', () => {
  for (const kind of ['web', 'worker'] as const) {
    it.skipIf(process.platform !== 'darwin')(`com.mymind.${kind}.plist lints and keeps the service alive`, () => {
      const tmpl = readFileSync(`deploy/macmini/com.mymind.${kind}.plist`, 'utf8')
      const f = join(dirname(root), `${kind}.plist`)
      writeFileSync(f, tmpl.replaceAll('__HOME__', '/Users/bridget'))
      execFileSync('plutil', ['-lint', '-s', f])
      const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }))
      expect(p).toMatchObject({
        Label: `com.mymind.${kind}`,
        ProgramArguments: ['/bin/bash', '/Users/bridget/mymind/bin/run.sh', kind],
        RunAtLoad: true,
        KeepAlive: true
      })
      // The worker drains in-flight runs for up to 60 s on SIGTERM before launchd's SIGKILL.
      expect(p.ExitTimeOut).toBeGreaterThanOrEqual(kind === 'worker' ? 90 : 10)
    })
  }
})

describe('deploy.yml', () => {
  const wf = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
  const steps: Array<{ name: string; if?: string; run?: string }> = wf.jobs.deploy.steps

  it('a push or a default manual run follows the repo variable; only an explicit choice overrides it', () => {
    expect(wf.jobs.deploy.env.DEPLOY_TARGET).toBe("${{ (inputs.target != 'auto' && inputs.target) || vars.DEPLOY_TARGET || 'lxc' }}")
    expect(wf.on.workflow_dispatch.inputs.target).toMatchObject({ options: ['auto', 'lxc', 'macmini'], default: 'auto' })
  })

  it('gates every runtime step on exactly one target; the rollback step runs only on failure', () => {
    for (const s of steps.slice(2, -1)) {
      const target = s.name.match(/^\[(lxc|macmini)\]/)?.[1]
      expect(target, s.name).toBeDefined()
      expect(s.if).toBe(`env.DEPLOY_TARGET == '${target}'`)
    }
    const last = steps.at(-1)!
    expect(last.if).toBe("(failure() || cancelled()) && env.DEPLOY_TARGET == 'macmini'")
    expect(last.run).toContain('release.sh undo $kind $rel')
    expect(last.run).toMatch(/for kind in worker web/)
  })

  it('lxc: the first runtime step refuses once the variables say the cutover is done', () => {
    const lxc = steps.filter(s => s.name.startsWith('[lxc]'))
    expect(lxc[0]!.name).toBe('[lxc] Refuse after cutover')
    const guard = lxc[0] as { env: Record<string, string>; run: string }
    expect(guard.env).toEqual({ VAR_TARGET: '${{ vars.DEPLOY_TARGET }}', CUTOVER_DONE: '${{ vars.MYMIND_CUTOVER_DONE }}' })
    const sh = (env: Record<string, string>) => spawnSync('bash', ['-c', guard.run], { env: { ...process.env, ...env }, encoding: 'utf8' }).status
    expect(sh({ VAR_TARGET: 'macmini', CUTOVER_DONE: '' })).toBe(1)
    expect(sh({ VAR_TARGET: 'lxc', CUTOVER_DONE: 'true' })).toBe(1)
    expect(sh({ VAR_TARGET: '', CUTOVER_DONE: '' })).toBe(0)
  })

  it('web gate: only a /api/health body carrying THIS sha passes', () => {
    const gate = steps.find(s => s.name.startsWith('[macmini] Web health'))!.run!
    // Run the gate's own match against candidate bodies (the curl loop itself needs the network).
    const match = gate.match(/grep -qF (.+?); then/)![1]!
    const ok = (body: string) => spawnSync('bash', ['-c', `printf '%s' "$BODY" | grep -qF ${match}`], { env: { ...process.env, BODY: body, GITHUB_SHA: 'abc123' } }).status === 0
    expect(ok('{"ok":true,"sha":"abc123"}')).toBe(true)
    expect(ok('{"ok":true,"sha":"0ld5ha"}')).toBe(false)
    expect(ok('{"ok":true,"sha":null}')).toBe(false)
    expect(ok('')).toBe(false)
  })

  it('macmini: never restarts LXC 114 units, migrates before activating, health-gates both with rollback', () => {
    const mini = steps.filter(s => s.name.startsWith('[macmini]'))
    const all = mini.map(s => s.run ?? '').join('\n')
    expect(all).not.toMatch(/systemctl (restart|start)/)
    expect(all).not.toMatch(/docker compose/)
    const at = (re: RegExp) => {
      const i = mini.findIndex(s => re.test(s.run ?? ''))
      expect(i, `a [macmini] step matching ${re}`).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(at(/release\.sh stage/)).toBeLessThan(at(/db:migrate/))
    expect(at(/eval --cancel-all/)).toBe(at(/db:migrate/))
    expect(at(/db:migrate/)).toBeLessThan(at(/release\.sh activate web/))
    expect(at(/release\.sh activate web/)).toBeLessThan(at(/192\.168\.2\.35:3000\/api\/health/))
    expect(at(/192\.168\.2\.35:3000\/api\/health/)).toBeLessThan(at(/release\.sh activate worker/))
    expect(at(/STAGED_WEB=/)).toBe(at(/release\.sh stage/))
    expect(at(/release\.sh activate worker/)).toBeLessThan(at(/release\.sh health worker/))
    expect(at(/release\.sh health worker/)).toBeLessThan(at(/release\.sh undo/))
    expect(all).toMatch(/release\.sh activate web && bash ~\/mymind\/bin\/release\.sh restart web/)
    expect(all).toMatch(/release\.sh activate worker && bash ~\/mymind\/bin\/release\.sh restart worker/)
    expect(all).toContain('.env.macmini')
  })

  it('final wave I2: a macmini run syncs, builds and migrates in /opt/mymind-build — never in the LXC runtime tree', () => {
    const sync = steps[1]!
    expect(sync.name).toBe('Sync code into LXC 114')
    const pick = sync.run!.split('\n').find(l => l.includes('dir=/opt/mymind-build'))!
    const dirFor = (target: string) => spawnSync('bash', ['-c', `${pick}\necho "$dir"`], { env: { ...process.env, DEPLOY_TARGET: target }, encoding: 'utf8' }).stdout.trim()
    expect(dirFor('macmini')).toBe('/opt/mymind-build')
    expect(dirFor('lxc')).toBe('/opt/mymind')
    expect(sync.run).toContain('mkdir -p $dir && cd $dir')
    expect(sync.run).toContain('tar -C "$dir" -xf -')
    expect(sync.run!.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')).not.toMatch(/\/opt\/mymind[/' ]/)
    const mini = steps.filter(s => s.name.startsWith('[macmini]')).map(s => s.run ?? '').join('\n')
    expect(mini).toContain('cd /opt/mymind-build && MYMIND_GIT_SHA=')
    expect(mini).toContain('cd /opt/mymind-build && set -a && . ./.env.macmini')
    expect(mini).toContain('/opt/mymind-build/.macmini-out/$kind')
    expect(mini).not.toMatch(/\/opt\/mymind(?!-build)/)
  })

  it('carries no SearXNG and no cycle-82 sandbox steps', () => {
    for (const f of ['.github/workflows/deploy.yml', 'deploy/provision-native.sh', '.claude/skills/prod-deploy/SKILL.md', 'docker-compose.prod.yml']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/searx/i)
    }
    expect(readFileSync('.github/workflows/deploy.yml', 'utf8')).not.toMatch(/sandbox/i)
  })
})

describe('build-artifacts.sh never builds in the LXC runtime tree (final wave I2)', () => {
  function tree(name: string) {
    const app = join(dirname(root), name)
    mkdirSync(join(app, 'deploy/macmini'), { recursive: true })
    for (const f of ['build-artifacts.sh', 'prune-arch.sh']) writeFileSync(join(app, 'deploy/macmini', f), readFileSync(`deploy/macmini/${f}`))
    return app
  }
  const fakePnpm = () => {
    const bin = join(dirname(root), 'fakebin'); mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\necho "pnpm $*" >> "$PNPM_LOG"\n', { mode: 0o755 })
    return bin
  }
  const build = (app: string, runtime: string) => {
    const log = join(dirname(root), 'pnpm.log')
    const r = spawnSync('bash', [join(app, 'deploy/macmini/build-artifacts.sh')], {
      env: { ...process.env, PATH: `${fakePnpm()}:${process.env.PATH}`, PNPM_LOG: log, MYMIND_LXC_RUNTIME_DIR: runtime },
      encoding: 'utf8'
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}`, pnpm: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('refuses when its checkout IS the LXC runtime dir (also through a symlink) and writes nothing', () => {
    const app = tree('opt-mymind')
    mkdirSync(join(app, '.output/server'), { recursive: true }); writeFileSync(join(app, '.output/server/index.mjs'), 'cycle-85')
    for (const runtime of [app, `${app}-link`]) {
      if (runtime !== app) execFileSync('ln', ['-s', app, runtime])
      const r = build(app, runtime)
      expect(r.code).toBe(1)
      expect(r.out).toContain('refusing to build in')
      expect(r.pnpm).toBe('')
    }
    expect(readFileSync(join(app, '.output/server/index.mjs'), 'utf8')).toBe('cycle-85')
    expect(existsSync(join(app, '.macmini-out'))).toBe(false)
  })

  it('a separate build checkout passes the guard (and goes on to install)', () => {
    const r = build(tree('opt-mymind-build'), tree('opt-mymind'))
    expect(r.out).not.toContain('refusing to build in')
    expect(r.pnpm).toContain('pnpm install --frozen-lockfile')
  })
})

describe('prune-arch.sh (final wave, Task 3 M1)', () => {
  const PRUNE = resolve('deploy/macmini/prune-arch.sh')
  const nodeFiles = (dir: string) => execFileSync('find', [dir, '-name', '*.node'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(f => f.slice(dir.length + 1)).sort()
  const prune = (...dirs: string[]) => { const r = spawnSync('bash', [PRUNE, ...dirs], { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` } }
  const PLATFORMS: Files = {
    'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node': 'x',
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node': 'x',
    'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node': 'x',
    'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node': 'x',
    'node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node': 'x',
    'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node': 'x',
    'node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node': 'x',
    'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node': 'x',
    'node_modules/@napi-rs/canvas-darwin-x64/skia.darwin-x64.node': 'x',
    'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib': 'x'
  }

  it('keeps exactly the linux-x64 and darwin-arm64 binaries, in every dir given', () => {
    const web = join(dirname(root), 'web'); const worker = join(dirname(root), 'worker')
    writeTree(web, PLATFORMS); writeTree(worker, PLATFORMS)
    const r = prune(web, worker)
    expect(r.code, r.out).toBe(0)
    for (const d of [web, worker]) {
      expect(nodeFiles(d)).toEqual([
        'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
        'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node',
        'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
        'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'
      ])
      expect(existsSync(join(d, 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib'))).toBe(true)
    }
  })

  it('fails the release when a platform that runs it has no binary left', () => {
    for (const lost of ['darwin-arm64', 'linux-x64']) {
      const d = join(dirname(root), `lost-${lost}`)
      writeTree(d, Object.fromEntries(Object.entries(PLATFORMS).filter(([p]) => !p.endsWith('.node') || !p.includes(lost))))
      const r = prune(d)
      expect(r.code).toBe(1)
      expect(r.out).toContain(`no ${lost} *.node left`)
    }
  })
})
