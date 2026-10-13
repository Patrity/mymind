// Cycle 86 final wave M5: the mini's env-file twin check (deploy/macmini/check-env-twins.sh, run by
// provision-macmini.sh) reads deploy/macmini/runtime-env-twins.txt. That file must be exactly what the
// runtimeConfig mapping implies: every plain key core's coreRuntimeConfig reads → NUXT_<key> (the
// override fromEnv / Nitro honour), plus nuxt.config.ts's own `process.env.X` runtimeConfig reads.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coreRuntimeConfig, fromEnv } from '@mymind/core/config-env'

const TWINS = 'deploy/macmini/runtime-env-twins.txt'
const CHECK = resolve('deploy/macmini/check-env-twins.sh')

/** The plain env keys coreRuntimeConfig reads — recorded through a Proxy env. */
function coreKeys(): string[] {
  const seen = new Set<string>()
  coreRuntimeConfig(new Proxy({}, { get: (_t, k) => { if (typeof k === 'string') seen.add(k); return undefined } }))
  return [...seen]
}

/** nuxt.config.ts's own runtimeConfig env reads, and the NUXT_ name Nitro maps each one's key to. */
function nuxtExtras(): Array<[string, string]> {
  const src = readFileSync('nuxt.config.ts', 'utf8')
  const rc = src.slice(src.indexOf('runtimeConfig: {'), src.indexOf('\n  nitro: {'))
  const out: Array<[string, string]> = []
  for (const m of rc.matchAll(/(\w+): [^\n]*process\.env\.([A-Z0-9_]+)/g)) {
    const key = m[1]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
    // `public: { allowSignup: … }` is the only nested block; its env names carry PUBLIC_.
    const isPublic = /public: \{[^}]*$/.test(rc.slice(0, m.index))
    out.push([m[2]!, `NUXT_${isPublic ? 'PUBLIC_' : ''}${key}`])
  }
  return out
}

function expected(): string[] {
  const pairs = [...coreKeys().map(k => [k, `NUXT_${k}`] as [string, string]), ...nuxtExtras()]
  return [...new Set(pairs.map(p => p.join(' ')))].sort()
}
const shipped = () => readFileSync(TWINS, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).sort()

describe('runtime-env-twins.txt is derived, not hand-kept', () => {
  it('equals the pairs the core mapper + nuxt.config imply (on drift: regenerate the list below)', () => {
    expect(shipped(), `expected ${TWINS} body:\n${expected().join('\n')}`).toEqual(expected())
  })

  it('sees nuxt.config\'s extras (the derivation is not vacuous)', () => {
    expect(nuxtExtras()).toEqual(expect.arrayContaining([['MAX_UPLOAD_BYTES', 'NUXT_MAX_UPLOAD_BYTES'], ['ALLOW_SIGNUP', 'NUXT_PUBLIC_ALLOW_SIGNUP']]))
    expect(coreKeys()).toEqual(expect.arrayContaining(['DATABASE_URL', 'STORAGE_S3_SECRET_ACCESS_KEY']))
  })

  it.each(coreKeys())('%s: its NUXT_ twin is the override the mapper honours', (k) => {
    expect(fromEnv({ [`NUXT_${k}`]: 'sentinel-x' })).not.toEqual(fromEnv({}))
  })
})

describe('check-env-twins.sh', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mm-twins-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const check = (body: string) => {
    const f = join(dir, 'mymind.env'); writeFileSync(f, body)
    const r = spawnSync('bash', [CHECK, f], { encoding: 'utf8' })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it('passes when every plain key set has every twin; never prints a value', () => {
    const r = check('DATABASE_URL=postgres://u:hunter2@192.168.2.80/bridget\nNUXT_DATABASE_URL=postgres://u:hunter2@192.168.2.80/bridget\nALLOW_SIGNUP=false\nNUXT_ALLOW_SIGNUP=false\nNUXT_PUBLIC_ALLOW_SIGNUP=false\nNITRO_PORT=3000\n')
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('hunter2')
  })

  it('names each missing twin — including the nuxt.config-only ones the old fixed list missed', () => {
    const r = check('MAX_UPLOAD_BYTES=1\nALLOW_SIGNUP=true\nNUXT_ALLOW_SIGNUP=true\nexport STORAGE_S3_BUCKET=b\n')
    expect(r.code).toBe(1)
    expect(r.out).toContain('sets MAX_UPLOAD_BYTES but not NUXT_MAX_UPLOAD_BYTES')
    expect(r.out).toContain('sets ALLOW_SIGNUP but not NUXT_PUBLIC_ALLOW_SIGNUP')
    expect(r.out).toContain('sets STORAGE_S3_BUCKET but not NUXT_STORAGE_S3_BUCKET')
    expect(r.out).not.toContain('NUXT_ALLOW_SIGNUP\n')
  })

  it('an empty value counts as unset (a twin with no value is missing)', () => {
    const r = check('DATABASE_URL=x\nNUXT_DATABASE_URL=\n')
    expect(r.code).toBe(1)
    expect(r.out).toContain('sets DATABASE_URL but not NUXT_DATABASE_URL')
  })
})

describe('provision-macmini.sh --check counts a missing twin as a problem (darwin, read-only)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mm-prov-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  const problems = (env: string) => {
    mkdirSync(join(root, 'env'), { recursive: true, mode: 0o700 })
    writeFileSync(join(root, 'env/mymind.env'), env, { mode: 0o600 })
    const r = spawnSync('bash', [resolve('deploy/macmini/provision-macmini.sh'), '--check'], { env: { ...process.env, MYMIND_ROOT: root }, encoding: 'utf8' })
    const out = `${r.stdout}${r.stderr}`
    return { n: Number(out.match(/\[provision\] (\d+) problem/)?.[1] ?? 0), out }
  }

  it.skipIf(process.platform !== 'darwin')('one plain key without its twin adds exactly one FAIL', () => {
    const base = problems('MAX_UPLOAD_BYTES=1\nNUXT_MAX_UPLOAD_BYTES=1\n')
    const missing = problems('MAX_UPLOAD_BYTES=1\n')
    expect(missing.out).toContain('[FAIL] env file sets MAX_UPLOAD_BYTES but not NUXT_MAX_UPLOAD_BYTES')
    expect(base.out).not.toContain('NUXT_MAX_UPLOAD_BYTES')
    expect(missing.n).toBe(base.n + 1)
  })
})
