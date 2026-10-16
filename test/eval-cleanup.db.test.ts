// Cycle 85 Task 2 fix round 1 / cycle 86 — what a world leaves outside its schema (its scratch dir, its
// uploads), and the worker-boot sweep. Real Postgres (shared dev DB); the filesystem and storage
// deletes are fakes (evalCleanupDeps) so nothing on the host is touched. Every schema / row made here
// is removed in afterAll. (Cycle 85's eval containers are gone with the Docker runtime.)
process.loadEnvFile('.env')
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { eq, sql } = await import('drizzle-orm')
const { useDb } = await import('@mymind/core/db')
const { evalSuites, evalRuns, images, voicePresets } = await import('@mymind/core/db/schema')
const { installEvalWorld, cleanupEvalRun } = await import('@mymind/core/lib/eval/world')
const { createEvalTenant, listEvalTenants, dropEvalSchema } = await import('@mymind/core/lib/eval/tenant')
const { evalCleanupDeps, sweepEvalLeftovers } = await import('@mymind/core/lib/eval/cleanup')

const db = () => useDb()
const BASE = '/tmp/mymind-eval-cleanup-test-never-created'
const removedDirs: string[] = []
const deletedUploads: string[] = []
let dirListing: string[] = []

const suiteName = `eval-cleanup-test-${randomUUID().slice(0, 8)}`
let suiteId = ''
const mySchemas: string[] = []

beforeAll(async () => {
  Object.assign(evalCleanupDeps, {
    rmDir: async (d: string) => { removedDirs.push(d) },
    listDir: async () => dirListing,
    deleteUpload: async (k: string) => { deletedUploads.push(k) },
    scratchBase: () => BASE,
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
  it('removes the run\'s scratch dir and the files it uploaded — never one Tony\'s rows use', async () => {
    const run = randomUUID()
    const w = await installEvalWorld(run, {})
    mySchemas.push(w.schema)
    const [shared] = await db().select({ k: images.storageKey }).from(images).limit(1)
    expect(shared).toBeDefined() // the dedup case below must really run
    const own = `evaltest-${randomUUID()}`
    const ownVoice = `evaltest-voice-${randomUUID()}`
    await w.run(async () => {
      await db().insert(images).values({ storageKey: own, mime: 'image/png', ext: 'png', size: 1 })
      await db().insert(images).values({ storageKey: shared!.k, mime: 'image/png', ext: 'png', size: 1 })
      await db().insert(voicePresets).values({ name: 'eval voice', instruction: 'calm', calibratedRefKey: ownVoice })
    })
    deletedUploads.length = 0
    removedDirs.length = 0
    await cleanupEvalRun(run)
    expect(removedDirs).toContain(`${BASE}/${w.schema}`)
    expect(deletedUploads.sort()).toEqual([own, ownVoice].sort()) // the shared key (dedup hit on Tony's file) is kept
    expect(await listEvalTenants()).not.toContain(w.schema)
  })
})

describe('cleanupEvalRun vs a world of the same run held elsewhere (N3)', () => {
  it('leaves that world\'s schema and scratch dir alone', async () => {
    const run = randomUUID()
    const elsewhere = await createEvalTenant(run) // held (locked) — as by another process
    mySchemas.push(elsewhere.schema)
    try {
      removedDirs.length = 0
      await cleanupEvalRun(run)
      expect(await listEvalTenants()).toContain(elsewhere.schema)
      expect(removedDirs.filter(d => d.includes(elsewhere.schema))).toEqual([])
    } finally {
      await elsewhere.pool.end()
      await elsewhere.lock.release()
    }
  })
})

describe('world.dispose outside the schema', () => {
  it('removes the world\'s own scratch dir only (no run-level sweep involved)', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    mySchemas.push(w.schema)
    removedDirs.length = 0
    await w.dispose()
    expect(removedDirs).toEqual([`${BASE}/${w.schema}`])
  })
})

describe('boot sweep (I2)', () => {
  it('drops finished / absent-and-stale / >2 h tenants with their scratch dirs; keeps live ones', async () => {
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
    dirListing = [...Object.values(s), 'eval_00000000000000000000000000000000_deadbeef', 'not-an-eval-dir']
    removedDirs.length = 0

    const r = await sweepEvalLeftovers({ keep: new Set([s.keptByProcess]) })
    const dropped = r.schemas.filter(x => Object.values(s).includes(x)).sort()
    expect(dropped).toEqual([s.absentStale, s.finishedYoung, s.runningOld].sort())
    const left = new Set(await listEvalTenants())
    for (const keep of [s.absentYoung, s.runningYoung, s.keptByProcess]) expect(left.has(keep)).toBe(true)
    for (const gone of dropped) expect(left.has(gone)).toBe(false)
    const mine = new Set([...Object.values(s), 'eval_00000000000000000000000000000000_deadbeef'])
    expect([...new Set(removedDirs.map(d => d.split('/').at(-1)!).filter(n => mine.has(n)))].sort()).toEqual([s.absentStale, s.finishedYoung, s.runningOld, 'eval_00000000000000000000000000000000_deadbeef'].sort())
    expect(removedDirs).not.toContain(`${BASE}/not-an-eval-dir`)
  })

  it('N3: a sweep-eligible world still held by a live process keeps its scratch dir', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    try {
      await db().execute(sql.raw(`comment on schema "${w.schema}" is 'created=${new Date(Date.now() - 3 * 3600_000).toISOString()}'`))
      dirListing = [w.schema]
      removedDirs.length = 0
      const r = await sweepEvalLeftovers()
      expect(r.schemas).not.toContain(w.schema)
      expect(removedDirs.filter(d => d.includes(w.schema))).toEqual([])
    } finally {
      await w.dispose()
    }
  })

  it('fix round 3: a failing upload listing never stops the drop; a dir that could not be removed is not reported', async () => {
    const a = await createEvalTenant(randomUUID()); await a.pool.end(); await a.lock.release(); mySchemas.push(a.schema)
    const b = await createEvalTenant(randomUUID()); await b.pool.end(); await b.lock.release(); mySchemas.push(b.schema)
    for (const t of [a, b]) await db().execute(sql.raw(`comment on schema "${t.schema}" is 'created=${new Date(Date.now() - 3 * 3600_000).toISOString()}'`))
    const saved = { listUploads: evalCleanupDeps.listUploads, rmDir: evalCleanupDeps.rmDir }
    evalCleanupDeps.listUploads = async () => { throw new Error('db hiccup') }
    evalCleanupDeps.rmDir = async (d: string) => { if (d.includes(b.schema)) throw new Error('EBUSY'); removedDirs.push(d) }
    dirListing = []
    try {
      const r = await sweepEvalLeftovers()
      expect(r.schemas).toEqual(expect.arrayContaining([a.schema, b.schema]))
      expect(r.dirs).toContain(a.schema)
      expect(r.dirs).not.toContain(b.schema)
    } finally { Object.assign(evalCleanupDeps, saved) }
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

