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
const { shadowableTables, listEvalTenants, evalRunPrefix, createEvalTenant, EVAL_REFERENCE_TABLES } = await import('@mymind/core/lib/eval/tenant')
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
    for (const t of EVAL_REFERENCE_TABLES) expect({ t, n: await count(world.schema, t) }).toEqual({ t, n: await count('public', t) })
    expect(await count(world.schema, 'memories')).toBe(2) // seeded + written, none of Tony's
    expect(await count(world.schema, 'connections')).toBe(0)
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

describe('eval tenant: cleanup', () => {
  it('dispose drops the schema; cleanupEvalRun drops live worlds and orphans; a dropped world writes nowhere', async () => {
    const run2 = randomUUID()
    const a = await installEvalWorld(run2, {})
    const b = await installEvalWorld(run2, {})
    // An orphan: a tenant created by a process that crashed before disposing it (never registered here).
    const orphan = await createEvalTenant(run2)
    await orphan.pool.end()
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
