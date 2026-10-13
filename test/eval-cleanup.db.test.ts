// Cycle 85 Task 2 fix round 1 — what a world leaves outside its schema, and the worker-boot sweep.
// Real Postgres (shared dev DB); docker, the filesystem and storage deletes are fakes (evalCleanupDeps)
// so nothing on the host is touched. Every schema / row made here is removed in afterAll.
process.loadEnvFile('.env')
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { eq, sql } = await import('drizzle-orm')
const { useDb } = await import('@mymind/core/db')
const { evalSuites, evalRuns, images } = await import('@mymind/core/db/schema')
const { installEvalWorld, cleanupEvalRun } = await import('@mymind/core/lib/eval/world')
const { createEvalTenant, listEvalTenants, dropEvalSchema } = await import('@mymind/core/lib/eval/tenant')
const { evalCleanupDeps, sweepEvalLeftovers } = await import('@mymind/core/lib/eval/cleanup')
const { LABEL_EVAL_RUN, LABEL_EVAL_WORLD } = await import('@mymind/core/lib/sandbox/docker')
type DockerRunner = import('@mymind/core/lib/sandbox/docker').DockerRunner

const db = () => useDb()
const BASE = '/tmp/mymind-eval-cleanup-test-never-created'
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false })

/** A fake docker daemon holding labelled containers. */
const containers = new Map<string, Record<string, string>>()
const dockerCalls: string[][] = []
const fakeDocker: DockerRunner = async (args) => {
  dockerCalls.push(args)
  if (args[0] === 'version') return ok('28.0')
  if (args[0] === 'ps') {
    const f = args[args.indexOf('--filter') + 1]!.replace(/^label=/, '')
    const [k, v] = f.split('=')
    const hits = [...containers].filter(([, l]) => k! in l && (v === undefined || l[k!] === v))
    return ok(hits.map(([id, l]) => `${id} ${l[LABEL_EVAL_WORLD] ?? ''}`).join('\n'))
  }
  if (args[0] === 'rm') { containers.delete(args.at(-1)!); return ok() }
  return ok()
}
const removedDirs: string[] = []
const deletedUploads: string[] = []
let dirListing: string[] = []

const suiteName = `eval-cleanup-test-${randomUUID().slice(0, 8)}`
let suiteId = ''
const mySchemas: string[] = []

beforeAll(async () => {
  Object.assign(evalCleanupDeps, {
    docker: fakeDocker,
    rmDir: async (d: string) => { removedDirs.push(d) },
    listDir: async () => dirListing,
    deleteUpload: async (k: string) => { deletedUploads.push(k) },
    workspacesBase: () => BASE,
    log: { info: () => {}, warn: () => {} }
  })
  const [s] = await db().insert(evalSuites).values({ name: suiteName }).returning({ id: evalSuites.id })
  suiteId = s!.id
})

afterAll(async () => {
  for (const sch of mySchemas) await dropEvalSchema(sch).catch(() => {})
  await db().delete(evalSuites).where(eq(evalSuites.id, suiteId)) // runs cascade
})

describe('cleanupEvalRun outside the schema (C1, Concern 5)', () => {
  it('removes the run\'s containers, its workspace dir and the files it uploaded — never one Tony\'s rows use', async () => {
    const run = randomUUID()
    const w = await installEvalWorld(run, {})
    mySchemas.push(w.schema)
    containers.set('c-mine', { [LABEL_EVAL_RUN]: run, [LABEL_EVAL_WORLD]: w.schema })
    containers.set('c-other', { [LABEL_EVAL_RUN]: randomUUID(), [LABEL_EVAL_WORLD]: 'eval_x' })
    containers.set('c-tony', { 'mymind.workspace': randomUUID() })
    const [shared] = await db().select({ k: images.storageKey }).from(images).limit(1)
    expect(shared).toBeDefined() // the dedup case below must really run
    const own = `evaltest-${randomUUID()}`
    await w.run(async () => {
      await db().insert(images).values({ storageKey: own, mime: 'image/png', ext: 'png', size: 1 })
      await db().insert(images).values({ storageKey: shared!.k, mime: 'image/png', ext: 'png', size: 1 })
    })
    deletedUploads.length = 0
    removedDirs.length = 0
    await cleanupEvalRun(run)
    expect([...containers.keys()].sort()).toEqual(['c-other', 'c-tony'])
    expect(removedDirs).toContain(`${BASE}/.eval/${w.schema}`)
    expect(deletedUploads).toEqual([own]) // the shared key (dedup hit on Tony's file) is kept
    expect(await listEvalTenants()).not.toContain(w.schema)
    containers.clear()
  })
})

describe('world.dispose outside the schema', () => {
  it('removes the world\'s own containers and dir (no run-level sweep involved)', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    mySchemas.push(w.schema)
    containers.set('c-world', { [LABEL_EVAL_RUN]: w.runId, [LABEL_EVAL_WORLD]: w.schema })
    containers.set('c-sibling', { [LABEL_EVAL_RUN]: w.runId, [LABEL_EVAL_WORLD]: 'eval_sibling' })
    removedDirs.length = 0
    await w.dispose()
    expect([...containers.keys()]).toEqual(['c-sibling']) // the same run's other world is untouched
    expect(removedDirs).toEqual([`${BASE}/.eval/${w.schema}`])
    containers.clear()
  })
})

describe('boot sweep (I2)', () => {
  it('drops finished / absent-and-stale / >2 h tenants with their containers and dirs; keeps live ones', async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    const stamp = (schema: string, iso: string) => db().execute(sql.raw(`comment on schema "${schema}" is 'created=${iso}'`))
    const make = async (runId: string, ageMs: number) => {
      const t = await createEvalTenant(runId)
      await t.pool.end()
      await t.lock.release() // as a crashed process's session would
      mySchemas.push(t.schema)
      await stamp(t.schema, at(ageMs))
      return t.schema
    }
    const runRow = async (status: string) => {
      const [r] = await db().insert(evalRuns).values({ suiteId, status }).returning({ id: evalRuns.id })
      return r!.id
    }
    const MIN = 60_000
    const s = {
      absentYoung: await make(randomUUID(), 1 * MIN),
      absentStale: await make(randomUUID(), 20 * MIN),
      finishedYoung: await make(await runRow('done'), 1 * MIN),
      runningYoung: await make(await runRow('running'), 1 * MIN),
      runningOld: await make(await runRow('running'), 3 * 60 * MIN),
      keptByProcess: await make(randomUUID(), 20 * MIN)
    }
    for (const [name, schema] of Object.entries(s)) containers.set(`c-${name}`, { [LABEL_EVAL_RUN]: 'x', [LABEL_EVAL_WORLD]: schema })
    containers.set('c-ghost', { [LABEL_EVAL_RUN]: 'x', [LABEL_EVAL_WORLD]: 'eval_00000000000000000000000000000000_deadbeef' })
    containers.set('c-tony', { 'mymind.workspace': randomUUID() })
    dirListing = [...Object.values(s), 'eval_00000000000000000000000000000000_deadbeef', 'not-an-eval-dir']
    removedDirs.length = 0

    const r = await sweepEvalLeftovers({ keep: new Set([s.keptByProcess]) })
    const dropped = r.schemas.filter(x => Object.values(s).includes(x)).sort()
    expect(dropped).toEqual([s.absentStale, s.finishedYoung, s.runningOld].sort())
    const left = new Set(await listEvalTenants())
    for (const keep of [s.absentYoung, s.runningYoung, s.keptByProcess]) expect(left.has(keep)).toBe(true)
    for (const gone of dropped) expect(left.has(gone)).toBe(false)
    expect([...containers.keys()].sort()).toEqual(['c-absentYoung', 'c-keptByProcess', 'c-runningYoung', 'c-tony'])
    const mine = new Set([...Object.values(s), 'eval_00000000000000000000000000000000_deadbeef'])
    expect([...new Set(removedDirs.map(d => d.split('/').at(-1)!).filter(n => mine.has(n)))].sort()).toEqual([s.absentStale, s.finishedYoung, s.runningOld, 'eval_00000000000000000000000000000000_deadbeef'].sort())
    containers.clear()
  })

  it('N3: a sweep-eligible world still held by a live process keeps its containers and dir', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    try {
      await db().execute(sql.raw(`comment on schema "${w.schema}" is 'created=${new Date(Date.now() - 3 * 3600_000).toISOString()}'`))
      containers.set('c-live', { [LABEL_EVAL_RUN]: w.runId, [LABEL_EVAL_WORLD]: w.schema })
      dirListing = [w.schema]
      removedDirs.length = 0
      const r = await sweepEvalLeftovers()
      expect(r.schemas).not.toContain(w.schema)
      expect(containers.has('c-live')).toBe(true)
      expect(removedDirs.filter(d => d.includes(w.schema))).toEqual([])
    } finally {
      containers.clear()
      await w.dispose()
    }
  })

  it('without the creation stamp a tenant counts as stale', async () => {
    const t = await createEvalTenant(randomUUID())
    await t.pool.end()
    await t.lock.release()
    mySchemas.push(t.schema)
    await db().execute(sql.raw(`comment on schema "${t.schema}" is null`))
    const r = await sweepEvalLeftovers()
    expect(r.schemas).toContain(t.schema)
  })
})

