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
  return release(['stage', kind, id], execFileSync('tar', ['-c', '-C', src, '.']))
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

  it('status prints each pointer', () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    stage('worker', 'z', WORKER)
    const out = release(['status']).out
    expect(out).toMatch(/^app\s+web-a$/m)
    expect(out).toMatch(/^\.worker-next\s+worker-z$/m)
    expect(out).toMatch(/^\.worker\s+-$/m)
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

  it('web: env file exported, NODE_ENV=production, 1536 MB heap, cwd = the real release dir, no worker-only vars', async () => {
    stage('web', 'a', WEB); release(['activate', 'web'])
    expect(run('web').status).toBe(0)
    const log = await logOf('web')
    expect(log).toContain('ARGS=--max-old-space-size=1536 .output/server/index.mjs')
    expect(log).toContain(`CWD=${realpathSync(join(root, 'releases/web-a'))}`)
    expect(log).toContain('NODE_ENV=production')
    expect(log).toContain('FROM_ENV_FILE=has a space')
    expect(log).toContain('AGENT_RUNTIME_EXCLUSIVE=<unset>')
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

  it('defaults to the lxc target and lets the repo variable or a manual run pick macmini', () => {
    expect(wf.jobs.deploy.env.DEPLOY_TARGET).toBe("${{ inputs.target || vars.DEPLOY_TARGET || 'lxc' }}")
    expect(wf.on.workflow_dispatch.inputs.target.options).toEqual(['lxc', 'macmini'])
  })

  it('gates every runtime step on exactly one target', () => {
    for (const s of steps.slice(2)) {
      const target = s.name.match(/^\[(lxc|macmini)\]/)?.[1]
      expect(target, s.name).toBeDefined()
      expect(s.if).toBe(`env.DEPLOY_TARGET == '${target}'`)
    }
  })

  it('macmini: never restarts LXC 114 units, migrates before activating, health-gates both with rollback', () => {
    const mini = steps.filter(s => s.name.startsWith('[macmini]'))
    const all = mini.map(s => s.run ?? '').join('\n')
    expect(all).not.toMatch(/systemctl (restart|start)/)
    expect(all).not.toMatch(/docker compose/)
    const at = (re: RegExp) => mini.findIndex(s => re.test(s.run ?? ''))
    expect(at(/release\.sh stage/)).toBeLessThan(at(/db:migrate/))
    expect(at(/eval --cancel-all/)).toBe(at(/db:migrate/))
    expect(at(/db:migrate/)).toBeLessThan(at(/release\.sh activate web/))
    expect(at(/release\.sh activate web/)).toBeLessThan(at(/192\.168\.2\.35:3000\/api\/health/))
    expect(at(/192\.168\.2\.35:3000\/api\/health/)).toBeLessThan(at(/release\.sh activate worker/))
    expect(at(/release\.sh activate worker/)).toBeLessThan(at(/release\.sh health worker/))
    expect(all).toContain('release.sh rollback web')
    expect(all).toContain('release.sh rollback worker')
    expect(all).toContain('.env.macmini')
  })

  it('carries no SearXNG and no cycle-82 sandbox steps', () => {
    for (const f of ['.github/workflows/deploy.yml', 'deploy/provision-native.sh', '.claude/skills/prod-deploy/SKILL.md', 'docker-compose.prod.yml']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/searx/i)
    }
    expect(readFileSync('.github/workflows/deploy.yml', 'utf8')).not.toMatch(/sandbox/i)
  })
})
