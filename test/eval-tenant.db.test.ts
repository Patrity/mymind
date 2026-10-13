// Cycle 85 Task 2 — the eval tenant against the real (shared dev) Postgres.
//
// What it proves (global constraint "eval isolation", Review Focus 1):
//   - a world shadows EVERY public table (except eval_*) and copies only the reference rows;
//   - every row written inside a world is VISIBLE to each read path when that path runs inside the
//     world, and INVISIBLE when it runs as Tony's real code — the "inside" half makes every
//     "outside" assertion non-vacuous (the same query, the same filters, would have found it);
//   - no id an eval write produced exists in any public table; the real pool is never touched
//     from inside a world; real work running beside a world still lands in public;
//   - live changes / activity rows / outbox sends never leave the world;
//   - dispose and cleanupEvalRun drop the tenant (and a dropped world cannot write anywhere).
//
// Shared dev DB: its own bus namespace; everything written outside a world is deleted in finally.
process.loadEnvFile('.env')
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// Embeddings / rerank outside a world go through ofetch → $fetch in tests: a fixed vector, no rig.
const VEC = Array.from({ length: 2560 }, (_, i) => (i === 7 ? 1 : 0))
vi.stubGlobal('$fetch', async (url: string) => {
  if (String(url).endsWith('/embed')) return [VEC]
  throw new Error(`test: no network (${String(url)})`)
})

// Zero network: the real transport, installed before the world's guard wraps globalThis.fetch.
const realFetch = globalThis.fetch
const transport = vi.fn(async (..._a: unknown[]) => new Response('REAL NETWORK'))
globalThis.fetch = transport as unknown as typeof fetch

const { eq, inArray, sql } = await import('drizzle-orm')
const { useDb, RoutingPool } = await import('@mymind/core/db')
const { tasks, channelDeliveries, activityLog } = await import('@mymind/core/db/schema')
const { installEvalWorld, cleanupEvalRun } = await import('@mymind/core/lib/eval/world')
const { shadowableTables, listEvalTenants, evalRunPrefix, createEvalTenant, dropEvalSchema, dropEvalRunTenants, evalTenantDeps, EVAL_LOCK_NS, EVAL_REFERENCE_TABLES, EVAL_SETTINGS_KEYS } = await import('@mymind/core/lib/eval/tenant')
const { setBusNs } = await import('@mymind/core/lib/bus/ns')
const { createTask, getTask, listTasks } = await import('@mymind/core/services/tasks')
const { createMemory, getMemory, listMemories, searchMemories } = await import('@mymind/core/services/memory')
const { createDoc, getDoc, listDocsSummary, searchDocs } = await import('@mymind/core/services/documents')
const { createConversation, appendMessages, listConversations } = await import('@mymind/core/services/conversations')
const { insertWorkstream, listWorkstreams, getWorkstream } = await import('@mymind/core/lib/agent/workstreams/store')
const { threadCandidates } = await import('@mymind/core/lib/agent/reflect/candidates')
const { buildLiveContext } = await import('@mymind/core/lib/agent/context')
const { toolByName } = await import('@mymind/core/lib/agent/tools')
const { insertDeliveries, deliveriesTick } = await import('@mymind/core/lib/channels/outbox')
const { recordEvent, recorder } = await import('@mymind/core/lib/observability/record')
const { subscribeChanges } = await import('@mymind/core/utils/live-bus')
const { sweepEvalLeftovers } = await import('@mymind/core/lib/eval/cleanup')
const { getDecryptedSecrets, getSandboxOptedSecrets } = await import('@mymind/core/lib/exec/secrets')
const { sandboxSecretEnv } = await import('@mymind/core/lib/sandbox/secrets')
const { getHome } = await import('../server/services/home')
const { searchAll } = await import('../server/services/search')

const NS = `evaltenant-${randomUUID().slice(0, 8)}`
const RUN = randomUUID()
const TAG = `evalleak${randomUUID().replace(/-/g, '').slice(0, 10)}`
const ctx = { signal: new AbortController().signal }
const db = () => useDb()

type World = Awaited<ReturnType<typeof installEvalWorld>>
let world: World
const ids: Record<string, string> = {}
const realTaskIds: string[] = []

beforeAll(async () => {
  setBusNs(NS)
  world = await installEvalWorld(RUN, {
    memories: [{ content: `${TAG} seeded memory about the eval world` }],
    tasks: [{ title: `${TAG} seeded task` }]
  })
  // Everything below is written INSIDE the world, through the real services.
  await world.run(async () => {
    ids.task = (await createTask({ title: `${TAG} written task` })).id
    ids.memory = (await createMemory({ content: `${TAG} written memory`, reviewed: true })).id
    ids.doc = (await createDoc({ path: `/eval/${TAG}.md`, title: `${TAG} doc`, content: `# ${TAG}\n\nbody ${TAG}` })).id
    const conv = await createConversation({ title: `${TAG} thread` })
    ids.conversation = conv.id
    await appendMessages(conv.id, [
      { role: 'user', content: `${TAG} one`, modality: 'text' }, { role: 'assistant', content: 'a', modality: 'text' },
      { role: 'user', content: `${TAG} two`, modality: 'text' }, { role: 'assistant', content: 'b', modality: 'text' }
    ])
    ids.workstream = (await insertWorkstream({ conversationId: conv.id, originConversationId: null, goal: `${TAG} goal`, toolsets: [], budget: { steps: 10 } as never })).id
    recordEvent({ kind: 'tool', name: `${TAG}-activity` } as never)
    const [delivery] = await useDb().transaction(tx => insertDeliveries(tx, [{ channel: 'imessage', target: `${TAG}-chat`, payload: { text: `${TAG} text` }, source: 'tool' }]))
    ids.delivery = delivery!
    await deliveriesTick()
  })
}, 120_000)

afterAll(async () => {
  try {
    if (realTaskIds.length) await db().delete(tasks).where(inArray(tasks.id, realTaskIds))
    await cleanupEvalRun(RUN)
    // Safety net: if isolation ever regresses (or a mutation check breaks it on purpose), the rows
    // that leaked into public carry TAG — remove them so the shared dev DB stays clean.
    const like = `${TAG}%`
    await db().execute(sql`delete from workstreams where goal like ${like}`)
    await db().execute(sql`delete from conversations where title like ${like}`)
    await db().execute(sql`delete from tasks where title like ${like}`)
    await db().execute(sql`delete from memories where content like ${like}`)
    await db().execute(sql`delete from documents where path like ${`/eval/${TAG}%`}`)
    await db().execute(sql`delete from channel_deliveries where target like ${like}`)
    await db().execute(sql`delete from activity_log where name like ${like}`)
  } finally {
    setBusNs(null)
    globalThis.fetch = realFetch
  }
})

describe('eval tenant: structure', () => {
  it('shadows every public table except eval_*, copying only the reference tables\' rows', async () => {
    const r = await db().execute(sql`select table_name from information_schema.tables where table_schema = ${world.schema} order by table_name`)
    const shadow = (r.rows as { table_name: string }[]).map(x => x.table_name)
    expect(shadow).toEqual(await shadowableTables())
    expect(shadow).toEqual(expect.arrayContaining(['tasks', 'memories', 'documents', 'conversations', 'conversation_messages', 'workstreams', 'run_events', 'activity_log', 'channel_deliveries', 'worker_commands']))
    expect(shadow.some(t => t.startsWith('eval_'))).toBe(false)
    const count = async (schema: string, t: string) => Number(((await db().execute(sql.raw(`select count(*)::int as n from "${schema}"."${t}"`))).rows[0] as { n: number }).n)
    for (const t of EVAL_REFERENCE_TABLES.filter(x => x !== 'settings')) expect({ t, n: await count(world.schema, t) }).toEqual({ t, n: await count('public', t) })
    expect(await count(world.schema, 'memories')).toBe(2) // seeded + written, none of Tony's
    expect(await count(world.schema, 'connections')).toBe(0)
  })
})

describe('eval tenant: settings allow-list (fix round 1, I1)', () => {
  const keys = async (schema: string) => ((await db().execute(sql.raw(`select key from "${schema}".settings order by key`))).rows as { key: string }[]).map(r => r.key)

  it('copies only allow-listed keys — the agent config, never a secret-bearing one', async () => {
    const pub = await keys('public')
    const mine = await keys(world.schema)
    expect(mine).toEqual(pub.filter(k => EVAL_SETTINGS_KEYS.includes(k)))
    // Non-vacuous: the dev DB holds secret-bearing keys that a wholesale copy would have carried.
    expect(pub).toEqual(expect.arrayContaining(['exec_secrets', 'channel_imessage']))
    for (const secret of ['exec_secrets', 'channel_imessage', 'channel_email', 'search_config', 'observability_config', 'image_config', 'analytics_config']) {
      expect(mine).not.toContain(secret)
      expect(EVAL_SETTINGS_KEYS).not.toContain(secret)
    }
    expect(mine).toContain('ai_config') // the model chain is there
  })

  it('in-world secret readers get nothing, even with Tony\'s secrets in the process cache', async () => {
    await getDecryptedSecrets() // warm the process cache from public (Tony's)
    expect(await world.run(() => getDecryptedSecrets())).toEqual({})
    expect(await world.run(() => getSandboxOptedSecrets())).toEqual({})
    expect(await world.run(() => sandboxSecretEnv({ tainted: false }))).toEqual({})
  })
})

describe('eval tenant: every read path', () => {
  // [name, read] — each read runs inside the world (must see the eval row) and outside (must not).
  const paths: [string, () => Promise<unknown>, (v: unknown) => boolean][] = [
    ['listTasks', () => listTasks(), v => (v as { id: string }[]).some(t => t.id === ids.task)],
    ['getTask', () => getTask(ids.task!), v => v !== null],
    ['search_tasks tool (MCP / agent)', () => toolByName('search_tasks')!.handler({ query: TAG }, ctx), v => JSON.stringify(v).includes(TAG)],
    ['listMemories', () => listMemories({ onlyIds: [ids.memory!] }), v => (v as unknown[]).length === 1],
    ['getMemory', () => getMemory(ids.memory!), v => v !== null],
    ['searchMemories (recall)', () => searchMemories(TAG), v => JSON.stringify(v).includes(TAG)],
    ['search_memories tool (MCP / agent)', () => toolByName('search_memories')!.handler({ query: TAG }, ctx), v => JSON.stringify(v).includes(TAG)],
    ['listDocsSummary', () => listDocsSummary({ limit: 200, offset: 0 }), v => (v as { id: string }[]).some(d => d.id === ids.doc)],
    ['getDoc', () => getDoc(ids.doc!), v => v !== null],
    ['searchDocs', () => searchDocs(TAG), v => JSON.stringify(v).includes(TAG)],
    ['list_documents tool (MCP / agent)', () => toolByName('list_documents')!.handler({}, ctx), v => JSON.stringify(v).includes(TAG)],
    ['listConversations', () => listConversations({ q: TAG }), v => JSON.stringify(v).includes(TAG)],
    ['listWorkstreams', () => listWorkstreams({ limit: 200 }), v => (v as { id: string }[]).some(w => w.id === ids.workstream)],
    ['getWorkstream', () => getWorkstream(ids.workstream!), v => v !== null],
    ['home', () => getHome('1d'), v => JSON.stringify(v).includes(TAG)],
    ['global search', () => searchAll(TAG), v => JSON.stringify(v).includes(TAG)],
    ['live context (every turn)', () => buildLiveContext(new Date()), v => String(v).includes(TAG)],
    ['reflect candidates (cron)', () => threadCandidates({ onlyConversationIds: [ids.conversation!], now: new Date(Date.now() + 3600_000) }), v => (v as unknown[]).length === 1],
    ['activity_log', () => db().select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.name, `${TAG}-activity`)), v => (v as unknown[]).length > 0],
    ['channel_deliveries (outbox claim)', () => db().select({ id: channelDeliveries.id }).from(channelDeliveries).where(eq(channelDeliveries.target, `${TAG}-chat`)), v => (v as unknown[]).length === 1]
  ]

  for (const [name, read, sees] of paths) {
    it(`${name}: visible inside the world, invisible outside`, async () => {
      if (name === 'activity_log') {
        // The world kept the row (never the global buffer); flush the real recorder to be sure.
        await recorder.flush()
        expect(world.activity).toEqual(expect.arrayContaining([expect.objectContaining({ name: `${TAG}-activity` })]))
        expect(sees(await read())).toBe(false)
        return
      }
      expect(sees(await world.run(read))).toBe(true)
      expect(sees(await read())).toBe(false)
    })
  }

  it('no id an eval write produced exists in any public table', async () => {
    const all = Object.values(ids)
    const r = await db().execute(sql`select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'id' and data_type = 'uuid'`)
    const tables = (r.rows as { table_name: string }[]).map(x => x.table_name)
    expect(tables.length).toBeGreaterThan(20)
    for (const t of tables) {
      const n = await db().execute(sql.raw(`select count(*)::int as n from public."${t}" where id::text in (${all.map(i => `'${i}'`).join(',')})`))
      expect({ t, n: (n.rows[0] as { n: number }).n }).toEqual({ t, n: 0 })
    }
  })

  it('the world made no outbound request (fetch transport never reached)', () => {
    expect(transport).not.toHaveBeenCalled()
    expect(world.blockedNetwork).toEqual([])
  })

  it('outbox / live events: captured in the world, nothing sent, no tab notified', async () => {
    expect(world.captured).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'outbox', detail: expect.objectContaining({ channel: 'imessage', target: `${TAG}-chat` }) })]))
    expect(world.suppressed.change).toBeGreaterThan(0) // insertWorkstream publishes
    const seen: unknown[] = []
    const off = subscribeChanges(e => seen.push(e))
    try {
      await world.run(async () => { await createTask({ title: `${TAG} silent` }) ; await toolByName('delete_task')!.handler({ id: ids.task! }, ctx) })
    } finally { off() }
    expect(seen).toEqual([])
  })
})

describe('eval tenant: routing', () => {
  it('inside a world the real pool is never touched', async () => {
    const origQuery = pg.Pool.prototype.query
    const origConnect = pg.Pool.prototype.connect
    const realCalls: string[] = []
    const q = vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(function (this: pg.Pool, ...args: unknown[]) {
      if (this instanceof RoutingPool) realCalls.push('query')
      return (origQuery as (...a: unknown[]) => unknown).apply(this, args) as never
    })
    const c = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(function (this: pg.Pool, ...args: unknown[]) {
      if (this instanceof RoutingPool) realCalls.push('connect')
      return (origConnect as (...a: unknown[]) => unknown).apply(this, args) as never
    })
    try {
      await world.run(async () => {
        await createTask({ title: `${TAG} routed` })
        await listTasks()
        await searchMemories(TAG)
        await db().transaction(async (tx) => { await tx.select().from(tasks).limit(1) })
      })
      expect(realCalls).toEqual([])
      // …and the spy does see the real pool outside a world (the assertion above can fail).
      await listTasks({ project: TAG })
      expect(realCalls.length).toBeGreaterThan(0)
    } finally {
      q.mockRestore()
      c.mockRestore()
    }
  })

  it('is per call chain: real work running beside the world lands in public', async () => {
    const [inside, outside] = await Promise.all([
      world.run(async () => { await new Promise(r => setTimeout(r, 10)); return createTask({ title: `${TAG} concurrent eval` }) }),
      (async () => { await new Promise(r => setTimeout(r, 5)); return createTask({ title: `${TAG} concurrent real` }) })()
    ])
    realTaskIds.push(outside.id)
    expect(await getTask(outside.id)).not.toBeNull()
    expect(await getTask(inside.id)).toBeNull()
    expect(await world.run(() => getTask(inside.id))).not.toBeNull()
    expect(await world.run(() => getTask(outside.id))).toBeNull()
  })
})

describe('eval tenant: fix round 1 (M5, M1, Concern 5)', () => {
  it('two live worlds never see each other\'s rows', async () => {
    const other = await installEvalWorld(RUN, {})
    try {
      const mine = await world.run(() => createTask({ title: `${TAG} world-a only` }))
      const theirs = await other.run(() => createTask({ title: `${TAG} world-b only` }))
      expect(await other.run(() => getTask(mine.id))).toBeNull()
      expect(await world.run(() => getTask(theirs.id))).toBeNull()
      expect(await other.run(() => getTask(theirs.id))).not.toBeNull()
      expect((await other.run(() => listMemories({ onlyIds: [ids.memory!] })))).toEqual([])
    } finally { await other.dispose() }
  })

  it('drift: a public table added after install is reported (the runner fails the attempt)', async () => {
    expect(await world.drift()).toEqual([])
    const t = `zz_eval_drift_${TAG}`
    await db().execute(sql.raw(`create table public."${t}" (id int)`))
    try {
      expect(await world.drift()).toEqual([t])
    } finally {
      await db().execute(sql.raw(`drop table public."${t}"`))
    }
    expect(await world.drift()).toEqual([])
  })

  it('a rolled-back outbox insert leaves no capture after settle(); a committed one stays', async () => {
    const before = world.captured.filter(c => c.kind === 'outbox').length
    await world.run(async () => {
      await expect(useDb().transaction(async (tx) => {
        await insertDeliveries(tx, [{ channel: 'imessage', target: `${TAG}-rolledback`, payload: { text: 'x' }, source: 'tool' }])
        throw new Error('roll back')
      })).rejects.toThrow('roll back')
      await useDb().transaction(tx => insertDeliveries(tx, [{ channel: 'imessage', target: `${TAG}-kept`, payload: { text: 'y' }, source: 'tool' }]))
    })
    expect(world.captured.filter(c => c.kind === 'outbox')).toHaveLength(before + 2)
    await world.settle()
    const outbox = world.captured.filter(c => c.kind === 'outbox')
    expect(outbox).toHaveLength(before + 1)
    expect(outbox.some(c => c.detail.target === `${TAG}-rolledback`)).toBe(false)
    expect(outbox.some(c => c.detail.target === `${TAG}-kept`)).toBe(true)
  })
})

describe('eval tenant: fix round 2 (N2)', () => {
  it('N2b: a live world whose schema is dropped from another connection fails closed — nothing lands in public', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    try {
      await w.run(() => createTask({ title: `${TAG} before the drop` })) // warms the pool's connections
      // A non-cooperating drop (bypassing the advisory lock), from a plain connection.
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
      await c.connect()
      try { await c.query(`drop schema "${w.schema}" cascade`) } finally { await c.end() }
      const why = async (p: Promise<unknown>) => { try { await p; return 'no error' } catch (e) { const err = e as Error & { cause?: Error }; return `${err.message} ${err.cause?.message ?? ''}` } }
      expect(await why(w.run(() => createTask({ title: `${TAG} after the drop` })))).toEqual(expect.stringContaining('no longer exists'))
      expect(await why(w.run(() => db().transaction(async (tx) => { await tx.insert(tasks).values({ title: `${TAG} tx after the drop`, columnId: randomUUID() } as never) })))).toEqual(expect.stringContaining('no longer exists'))
      const leaked = await db().select({ id: tasks.id }).from(tasks).where(sql`${tasks.title} like ${`${TAG} %after the drop`}`)
      expect(leaked).toEqual([])
    } finally { await w.dispose() }
  })

  it('N2a: a live world\'s schema is never dropped by dropEvalSchema / the sweep / cleanupEvalRun from elsewhere', async () => {
    const run = randomUUID()
    const w = await installEvalWorld(run, {})
    try {
      // Make it sweep-eligible on every count: stale, and no run row.
      await db().execute(sql.raw(`comment on schema "${w.schema}" is 'created=${new Date(Date.now() - 3 * 3600_000).toISOString()}'`))
      expect(await dropEvalSchema(w.schema)).toBe(false)
      const r = await sweepEvalLeftovers({ keep: new Set() }) // as another process's boot sweep (keeps nothing)
      expect(r.schemas).not.toContain(w.schema)
      // cleanupEvalRun in ANOTHER process: no live world of the run there, only the locked tenant.
      expect(await dropEvalRunTenants(run)).toBe(0)
      expect(await listEvalTenants()).toContain(w.schema)
      expect(await w.run(() => createTask({ title: `${TAG} still mine` }))).toMatchObject({ title: `${TAG} still mine` })
    } finally { await w.dispose() }
    expect(await listEvalTenants()).not.toContain(w.schema)
  })
})

describe('eval tenant: fix round 3 (B2, B3, B4, pool.end)', () => {
  const lockRow = (schema: string) => db().execute(sql`select pid, classid::bigint as ns, objsubid from pg_locks
    where locktype = 'advisory' and granted and objsubid = 2 and classid = ${EVAL_LOCK_NS}::oid
      and objid = ((hashtext(${schema})::bigint + 4294967296) % 4294967296)::oid`)

  it('B4: the world lock lives in the two-int key space under the eval namespace', async () => {
    const r = await lockRow(world.schema)
    expect(r.rows).toEqual([expect.objectContaining({ ns: String(EVAL_LOCK_NS), objsubid: 2 })])
    // …and nothing in the single-bigint space for it.
    const single = await db().execute(sql`select 1 from pg_locks where locktype = 'advisory' and objsubid = 1 and objid = ((hashtext(${world.schema})::bigint + 4294967296) % 4294967296)::oid`)
    expect(single.rows).toEqual([])
  })

  it('B3: the lock is held before the schema is ever visible', async () => {
    const run = randomUUID()
    const prefix = evalRunPrefix(run)
    const sightings: { vis: string; locked: boolean }[] = []
    let done = false
    const poll = (async () => {
      while (!done) {
        const r = await db().execute(sql`select n.nspname as vis, exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.granted and l.objsubid = 2
            and l.classid = ${EVAL_LOCK_NS}::oid and l.objid = ((hashtext(n.nspname)::bigint + 4294967296) % 4294967296)::oid) as locked
          from pg_namespace n where n.nspname like ${`${prefix}%`}`)
        for (const row of r.rows as { vis: string; locked: boolean }[]) sightings.push(row)
      }
    })()
    const t = await createEvalTenant(run)
    done = true
    await poll
    try {
      expect(sightings.length).toBeGreaterThan(0)
      expect(sightings.every(x => x.locked)).toBe(true)
    } finally {
      await t.pool.end(); await t.lock.release(); await dropEvalSchema(t.schema)
    }
  })

  it('B2: a world whose lock session dies fails closed at once — even with its schema still there', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    try {
      await w.run(() => createTask({ title: `${TAG} before the lock loss` }))
      const [row] = (await lockRow(w.schema)).rows as { pid: number }[]
      expect(row).toBeDefined()
      await db().execute(sql`select pg_terminate_backend(${row!.pid})`)
      for (let i = 0; i < 50 && (await lockRow(w.schema)).rows.length; i++) await new Promise(r => setTimeout(r, 20))
      await new Promise(r => setTimeout(r, 50)) // the client sees the end
      expect(await listEvalTenants()).toContain(w.schema) // not dropped — the pool refuses anyway
      const why = async (p: Promise<unknown>) => { try { await p; return 'no error' } catch (e) { const err = e as Error & { cause?: Error }; return `${err.message} ${err.cause?.message ?? ''}` } }
      expect(await why(w.run(() => createTask({ title: `${TAG} after the lock loss` })))).toEqual(expect.stringContaining('lost its lock'))
      const leaked = await db().select({ id: tasks.id }).from(tasks).where(eq(tasks.title, `${TAG} after the lock loss`))
      expect(leaked).toEqual([])
    } finally { await w.dispose() }
    expect(await listEvalTenants()).not.toContain(w.schema)
  })

  it('B2: a lock connection that just ENDS (no error) marks the tenant gone too', async () => {
    const t = await createEvalTenant(randomUUID())
    try {
      const c = await t.pool.connect(); c.release() // works while locked
      t.lock._connection.emit('end')
      await expect(t.pool.connect()).rejects.toThrow(/lost its lock/)
    } finally { await t.pool.end(); await t.lock.release(); await dropEvalSchema(t.schema) }
  })

  it('pool.end times out on a leaked client, destroys it, and dispose still drops the world', async () => {
    const w = await installEvalWorld(randomUUID(), {})
    const before = evalTenantDeps.poolEndTimeoutMs
    evalTenantDeps.poolEndTimeoutMs = 300
    try {
      await w.run(async () => { await createTask({ title: `${TAG} leak` }); await (await import('@mymind/core/db')).useDb().$client.connect() }) // never released
      const t0 = Date.now()
      await w.dispose()
      expect(Date.now() - t0).toBeLessThan(5_000)
      expect(await listEvalTenants()).not.toContain(w.schema)
    } finally { evalTenantDeps.poolEndTimeoutMs = before }
  })
})

describe('eval tenant: cleanup', () => {
  it('dispose drops the schema; cleanupEvalRun drops live worlds and orphans; a dropped world writes nowhere', async () => {
    const run2 = randomUUID()
    const a = await installEvalWorld(run2, {})
    const b = await installEvalWorld(run2, {})
    // An orphan: a tenant created by a process that crashed before disposing it (never registered here).
    const orphan = await createEvalTenant(run2)
    await orphan.pool.end()
    await orphan.lock.release() // its process died: the session lock went with it
    await a.run(() => createTask({ title: `${TAG} doomed` }))
    const mine = async () => (await listEvalTenants()).filter(n => n.startsWith(evalRunPrefix(run2)))
    expect(await mine()).toHaveLength(3)
    await a.dispose()
    expect(await mine()).not.toContain(a.schema)
    const { dropped } = await cleanupEvalRun(run2)
    expect(dropped).toBe(2) // b (live) + the orphan
    expect(await mine()).toEqual([])
    await expect(b.run(() => createTask({ title: `${TAG} after cleanup` }))).rejects.toThrow()
    expect((await listTasks()).some(t => t.title.startsWith(`${TAG} after`) || t.title.startsWith(`${TAG} doomed`))).toBe(false)
  })
})
