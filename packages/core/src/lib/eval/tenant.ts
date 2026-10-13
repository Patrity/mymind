// Cycle 85 (spec §3.2): the eval tenant — where an eval world's MyMind rows live.
//
// Decision (plan Task 2, "column vs schema"): a dedicated Postgres SCHEMA per world, not an
// `eval_run_id` column. Each world gets `eval_<run hex>_<suffix>` holding a shadow of EVERY public
// table (structure, defaults, indexes, generated columns, foreign keys), plus a copy of the few
// reference tables the agent needs to run (EVAL_REFERENCE_TABLES). The app's one pool routes a call
// chain inside an eval scope to the world's pool, whose connections run with
// `search_path = <schema>, public` (db/index.ts) — so the same unqualified drizzle SQL reads and
// writes the world's tables. Blast radius: zero read-path filters. Tony's queries run on the
// default search_path and physically cannot see a world's rows; a table added in a future
// migration is shadowed automatically (it is enumerated at creation time), where a column would
// need a new filter in every read path forever. Cleanup is one `DROP SCHEMA … CASCADE`.
//
// Not shadowed: `eval_*` (the eval system's own suites/runs/results, written by the runner) and
// non-public schemas (drizzle's migration ledger). Sequences stay public (a bigserial default
// still draws from public's sequence — ids only, never rows).
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { coreConfig } from '../../config'
import { useDb } from '../../db'
import { outsideEvalScope } from './context'

export const EVAL_SCHEMA_PREFIX = 'eval_'

/** Public tables a world never shadows: the eval system's own records. */
export function isUnshadowedTable(name: string): boolean {
  return name.startsWith('eval_')
}

/** Reference tables whose rows are copied into every world: what the agent needs to run (its AI /
 *  channel / search settings, profile and skills, task columns, projects, prices). Everything else
 *  starts EMPTY — a world sees none of Tony's memories, tasks, documents or conversations; a case
 *  seeds what it needs through `setup`. */
export const EVAL_REFERENCE_TABLES: readonly string[] = [
  'user', 'settings', 'projects', 'task_columns', 'agent_files', 'agent_profile', 'agent_skills',
  'prompt_commands', 'model_prices'
]

/**
 * Fix round 1 (I1): `settings` is copied by an explicit KEY allow-list — what the agent needs to run
 * (its model chain, behaviour and persona), never a secret-bearing key: exec_secrets, channel_*
 * (BlueBubbles password, webhook token, e-mail), search_config (Brave key), observability_config
 * (Resend key), image_config (rig keys)… A key not listed here is never copied — a new
 * secret-bearing key is safe by default.
 */
export const EVAL_SETTINGS_KEYS: readonly string[] = [
  'ai_config', 'agent_settings', 'agent_persona', 'agent_skills_enabled', 'agent_timezone',
  'self_improvement_mode', 'search_relevance', 'chunking'
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEMA = /^eval_[0-9a-f]{32}_[0-9a-f]{8}$/
const IDENT = /^[a-z_][a-z0-9_]*$/

/** `eval_<run hex>_` — every world of one run shares it (cleanupEvalRun drops by prefix). */
export function evalRunPrefix(runId: string): string {
  if (!UUID.test(runId)) throw new Error(`eval: run id must be a uuid (got "${runId}")`)
  return `${EVAL_SCHEMA_PREFIX}${runId.replace(/-/g, '').toLowerCase()}_`
}

export function newEvalSchemaName(runId: string): string {
  return `${evalRunPrefix(runId)}${randomBytes(4).toString('hex')}`
}

function assertSchema(name: string): string {
  if (!SCHEMA.test(name)) throw new Error(`eval: not an eval tenant schema: "${name}"`)
  return name
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`eval: unexpected identifier "${name}"`)
  return `"${name}"`
}

export interface EvalTenant {
  schema: string
  pool: pg.Pool
  /** Fix round 2 (N2a): held for the world's whole life — nothing else drops a held schema. */
  lock: TenantLock
}

/** Thrown when a world's schema is gone: its pool refuses to run anything (N2b). */
export class EvalTenantGoneError extends Error {
  constructor(public schema: string, why = 'no longer exists') {
    super(`eval: the tenant schema ${schema} ${why} — refusing to run (writes would fall through to public)`)
    this.name = 'EvalTenantGoneError'
  }
}

/**
 * Fix round 2 (N2b): the tenant pool fails CLOSED when its schema is missing. Postgres silently
 * skips a missing schema in search_path, so without this a dropped tenant would resolve every
 * unqualified table to Tony's public one. Every checkout — `pool.query` checks out through
 * `connect` too — first verifies the schema exists on that very connection. (search_path keeps
 * `public` for the extension types / operators: vector, ltree, pg_trgm, pgcrypto live there.) A
 * cooperating drop (sweep, cleanupEvalRun) is already excluded by the advisory lock (N2a).
 */
export class TenantPool extends pg.Pool {
  /** Fix round 3 (B2): set when the world's lock session died — refuse at once, no round trip. */
  private goneReason: string | null = null
  constructor(config: pg.PoolConfig, private readonly tenantSchema: string) { super(config) }

  markGone(reason: string): void { this.goneReason ??= reason }
  get gone(): boolean { return this.goneReason !== null }

  override connect(): Promise<pg.PoolClient>
  override connect(cb: (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void): void
  override connect(cb?: (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void): Promise<pg.PoolClient> | void {
    const checked = (async () => {
      if (this.goneReason) throw new EvalTenantGoneError(this.tenantSchema, this.goneReason)
      const client = await super.connect()
      try {
        const r = await client.query<{ ok: boolean }>('select to_regnamespace($1) is not null as ok', [this.tenantSchema])
        if (!r.rows[0]?.ok) throw new EvalTenantGoneError(this.tenantSchema)
      } catch (err) {
        client.release(true)
        throw err
      }
      return client
    })()
    if (!cb) return checked
    checked.then(c => cb(undefined, c, (release?: unknown) => c.release(release as boolean | Error | undefined)), (e: Error) => cb(e, undefined, () => {}))
  }
}

/** A session advisory lock on a dedicated connection (not the routed pool). */
export interface TenantLock {
  release(): Promise<void>
  /** The lock session's backend pid (tests). */
  readonly pid: number | undefined
  /** The lock session's connection (tests: simulate its loss). */
  readonly _connection: { emit(event: string, ...a: unknown[]): boolean }
}

/**
 * Fix round 3 (B4): the two-int advisory key space, under this eval namespace — disjoint from the
 * single-bigint `hashtext(...)` keys the app's own transaction locks use, so a world's
 * session-long lock can never collide with an agent-run claim or a workstream-tree spawn. Every
 * acquire, try and release uses this same (EVAL_LOCK_NS, hashtext(schema)) pair.
 */
export const EVAL_LOCK_NS = 85_085
const lockSql = `select pg_advisory_lock(${EVAL_LOCK_NS}, hashtext($1))`
const tryLockSql = `select pg_try_advisory_lock(${EVAL_LOCK_NS}, hashtext($1)) as ok`
const unlockSql = `select pg_advisory_unlock(${EVAL_LOCK_NS}, hashtext($1))`

function lockClient(): pg.Client {
  return new pg.Client({ connectionString: coreConfig().databaseUrl })
}

/**
 * Takes (waits for) the world's lock — held until release(). Fix round 3 (B2): if the lock session
 * dies before release() (a Postgres restart, a reset, idle_session_timeout), `onLost` is called
 * once — the caller marks the tenant gone (a world without its lock could be dropped under it).
 */
export function holdTenantLock(schema: string, onLost: (why: string) => void = () => {}): Promise<TenantLock> {
  assertSchema(schema)
  return outsideEvalScope(async () => {
    const c = lockClient()
    let released = false
    let lost = false
    const lose = (why: string) => {
      if (released || lost) return
      lost = true
      console.error(`[eval] tenant ${schema} lost its lock (${why}) — the world fails closed`)
      onLost(why)
    }
    c.on('error', err => lose(`lock connection error: ${err.message}`))
    c.on('end', () => lose('lock connection ended'))
    await c.connect()
    try { await c.query(lockSql, [schema]) } catch (err) { released = true; await c.end().catch(() => {}); throw err }
    return {
      pid: (c as unknown as { processID?: number }).processID,
      _connection: c,
      release: async () => {
        if (released) return
        released = true
        await c.query(unlockSql, [schema]).catch(() => {})
        await c.end().catch(() => {})
      }
    }
  })
}

/** Runs `fn` only if the schema's lock is free (pg_try_advisory_lock), holding it meanwhile.
 *  Returns false — and runs nothing — when a live world holds it (N2a / N3). */
export function withTenantLock(schema: string, fn: () => Promise<void>): Promise<boolean> {
  assertSchema(schema)
  return outsideEvalScope(async () => {
    const c = lockClient()
    c.on('error', err => console.error(`[eval] tenant ${schema} try-lock connection error:`, err.message))
    await c.connect()
    try {
      const r = await c.query<{ ok: boolean }>(tryLockSql, [schema])
      if (!r.rows[0]?.ok) return false
      try { await fn() } finally { await c.query(unlockSql, [schema]).catch(() => {}) }
      return true
    } finally {
      await c.end().catch(() => {})
    }
  })
}

/** DDL always runs on Tony's real pool (it creates the tenant), never inside a world. */
function adminDb() {
  return useDb()
}

/** Every shadowable public table (all of public except `eval_*`), sorted. */
export async function shadowableTables(): Promise<string[]> {
  return outsideEvalScope(async () => {
    const r = await adminDb().execute(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`)
    return (r.rows as { tablename: string }[]).map(x => x.tablename).filter(t => !isUnshadowedTable(t))
  })
}

/** Creates a world's schema (shadow tables + foreign keys + reference rows) and its pool. */
export async function createEvalTenant(runId: string): Promise<EvalTenant> {
  const schema = assertSchema(newEvalSchemaName(runId))
  const s = ident(schema)
  // Fix round 3 (B3): the lock first — no drop path can slip in between CREATE SCHEMA and the lock.
  let pool: TenantPool | null = null
  const lostBeforePool: string[] = []
  const lock = await holdTenantLock(schema, (why) => { if (pool) pool.markGone(`lost its lock (${why})`); else lostBeforePool.push(why) })
  try {
    await outsideEvalScope(async () => {
      const tables = await shadowableTables()
      await adminDb().transaction(async (tx) => {
        await tx.execute(sql.raw(`create schema ${s}`))
        // Fix round 1 (I2): the creation time, for the boot sweep's age rule.
        await tx.execute(sql.raw(`comment on schema ${s} is 'created=${new Date().toISOString()}'`))
        for (const t of tables) {
          await tx.execute(sql.raw(`create table ${s}.${ident(t)} (like public.${ident(t)} including all)`))
        }
        for (const t of EVAL_REFERENCE_TABLES) {
          if (!tables.includes(t)) continue
          const cols = await tx.execute(sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = ${t} and is_generated = 'NEVER' order by ordinal_position`)
          const list = (cols.rows as { column_name: string }[]).map(c => `"${c.column_name.replace(/"/g, '""')}"`).join(', ')
          if (!list) continue
          const where = t === 'settings' ? ` where key in (${EVAL_SETTINGS_KEYS.map(k => `'${k.replace(/'/g, "''")}'`).join(', ')})` : ''
          await tx.execute(sql.raw(`insert into ${s}.${ident(t)} (${list}) select ${list} from public.${ident(t)}${where}`))
        }
        // Foreign keys (LIKE copies none): re-pointed at the world's own tables. NOT VALID — the
        // reference rows copied above may point at rows a world does not carry; new rows are checked.
        const fks = await tx.execute(sql`select r.relname as tbl, c.conname as name, pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace
          where c.contype = 'f' and n.nspname = 'public' order by r.relname, c.conname`)
        for (const fk of fks.rows as { tbl: string, name: string, def: string }[]) {
          if (!tables.includes(fk.tbl)) continue
          const def = retargetForeignKey(fk.def, schema)
          await tx.execute(sql.raw(`alter table ${s}.${ident(fk.tbl)} add constraint "${fk.name.replace(/"/g, '""')}" ${def} not valid`))
        }
      })
    })
  } catch (err) {
    await lock.release()
    throw err
  }
  pool = new TenantPool({
    connectionString: coreConfig().databaseUrl,
    max: 4,
    options: `-c search_path=${schema},public`
  }, schema)
  if (lostBeforePool.length) pool.markGone(`lost its lock (${lostBeforePool[0]})`)
  pool.on('error', err => console.error(`[eval] tenant ${schema} idle client error:`, err.message))
  return { schema, pool, lock }
}

/** `FOREIGN KEY (x) REFERENCES [public.]t(id) …` → `… REFERENCES "<schema>".t(id) …` (an `eval_*`
 *  target stays in public). */
export function retargetForeignKey(def: string, schema: string): string {
  return def.replace(/REFERENCES\s+(?:public\.)?("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(/, (_m, q: string, table: string) =>
    isUnshadowedTable(table) ? `REFERENCES public.${q}${table}${q}(` : `REFERENCES "${schema}".${q}${table}${q}(`)
}

/** Ends the world's pool, releases its lock and drops its schema (under the lock). Idempotent. */
export async function dropEvalTenant(t: EvalTenant): Promise<void> {
  const schema = assertSchema(t.schema)
  await endPool(t.pool, schema)
  await t.lock.release()
  await withTenantLock(schema, () => dropSchemaNow(schema))
}

/** The DROP itself — callers hold the schema's lock (withTenantLock). */
export async function dropSchemaNow(schema: string): Promise<void> {
  await outsideEvalScope(() => adminDb().execute(sql.raw(`drop schema if exists ${ident(assertSchema(schema))} cascade`)))
}

/** Every eval tenant schema in the database (all runs), e.g. to sweep after a crash. */
export async function listEvalTenants(): Promise<string[]> {
  return outsideEvalScope(async () => {
    const r = await adminDb().execute(sql`select nspname from pg_namespace where nspname like 'eval\\_%' order by nspname`)
    return (r.rows as { nspname: string }[]).map(x => x.nspname).filter(n => SCHEMA.test(n))
  })
}

/** Drops every tenant schema of one run (whatever process created them). Returns how many. */
export async function dropEvalRunTenants(runId: string): Promise<number> {
  const prefix = evalRunPrefix(runId)
  const mine = (await listEvalTenants()).filter(n => n.startsWith(prefix))
  let dropped = 0
  for (const n of mine) if (await withTenantLock(n, () => dropSchemaNow(n))) dropped++
  return dropped
}

/** Fix round 1 (M1): public tables the world does not shadow (a migration applied after the world
 *  was built). In-world SQL naming such a table would fall through the search_path to Tony's
 *  public table — the runner fails the attempt instead. [] = no drift. */
export async function tenantDrift(schema: string): Promise<string[]> {
  assertSchema(schema)
  const want = await shadowableTables()
  const r = await outsideEvalScope(() => adminDb().execute(sql`select tablename from pg_tables where schemaname = ${schema}`))
  const have = new Set((r.rows as { tablename: string }[]).map(x => x.tablename))
  return want.filter(t => !have.has(t))
}

/** Storage-key columns: files a world may have uploaded (images, attachments, agent files, voice). */
const STORAGE_KEY_COLUMNS: readonly [string, string][] = [
  ['images', 'storage_key'], ['clip_attachments', 'storage_key'], ['agent_files', 'storage_key'], ['voice_presets', 'ref_storage_key'],
  ['voice_presets', 'calibrated_ref_key'] // fix round 2 (N5)
]

/** Storage keys referenced in the world's tenant but by NO public row — the uploads the world made
 *  (storage dedups by content, so a key Tony's rows also use is never returned). */
export async function tenantOnlyStorageKeys(schema: string): Promise<string[]> {
  const s = ident(assertSchema(schema))
  const out = new Set<string>()
  await outsideEvalScope(async () => {
    for (const [t, c] of STORAGE_KEY_COLUMNS) {
      const exists = await adminDb().execute(sql`select 1 from pg_tables where schemaname = ${schema} and tablename = ${t}`)
      if (!exists.rows.length) continue
      const r = await adminDb().execute(sql.raw(`select distinct w.${ident(c)} as k from ${s}.${ident(t)} w where w.${ident(c)} is not null
        and not exists (${STORAGE_KEY_COLUMNS.map(([pt, pc]) => `select 1 from public.${ident(pt)} p where p.${ident(pc)} = w.${ident(c)}`).join(' union all ')})`))
      for (const row of r.rows as { k: string }[]) out.add(row.k)
    }
  })
  return [...out]
}

export interface EvalTenantInfo { schema: string; runId: string; createdAt: Date | null }

/** Every tenant with its run id and creation time (null for a schema without the stamp). */
export async function evalTenantInfo(): Promise<EvalTenantInfo[]> {
  return outsideEvalScope(async () => {
    const r = await adminDb().execute(sql`select nspname, obj_description(oid, 'pg_namespace') as note from pg_namespace where nspname like 'eval\\_%' order by nspname`)
    return (r.rows as { nspname: string, note: string | null }[]).filter(x => SCHEMA.test(x.nspname)).map((x) => {
      const hex = x.nspname.slice(EVAL_SCHEMA_PREFIX.length, EVAL_SCHEMA_PREFIX.length + 32)
      const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      const m = /created=(\S+)/.exec(x.note ?? '')
      const at = m ? new Date(m[1]!) : null
      return { schema: x.nspname, runId, createdAt: at && !Number.isNaN(at.getTime()) ? at : null }
    })
  })
}

/** Drops one tenant schema by name, only when no live world holds it. True when dropped. */
export function dropEvalSchema(schema: string): Promise<boolean> {
  return withTenantLock(schema, () => dropSchemaNow(schema))
}

/** Whether a schema exists (fresh read). */
export async function schemaExists(schema: string): Promise<boolean> {
  const r = await outsideEvalScope(() => adminDb().execute(sql`select to_regnamespace(${schema}) is not null as ok`))
  return (r.rows[0] as { ok: boolean } | undefined)?.ok === true
}

/** Seams (tests). */
export const evalTenantDeps = { poolEndTimeoutMs: 10_000 }

/**
 * `pool.end()` waits for every checked-out client — a leaked one (never released) would hang
 * dispose forever, holding the lock. Out-of-scope fix: after `poolEndTimeoutMs`, destroy the
 * remaining clients' sockets and move on.
 */
async function endPool(pool: pg.Pool, schema: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ended = pool.end().then(() => 'ended' as const, () => 'ended' as const)
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), evalTenantDeps.poolEndTimeoutMs) })
  const how = await Promise.race([ended, timeout])
  clearTimeout(timer)
  if (how === 'ended') return
  console.warn(`[eval] tenant ${schema}: pool.end timed out (a client was never released) — destroying its connections`)
  for (const c of (pool as unknown as { _clients?: { on?: (e: string, f: () => void) => void; connection?: { stream?: { destroy?: () => void } } }[] })._clients ?? []) {
    try {
      c.on?.('error', () => {}) // a checked-out client has no listener: its forced end must not crash the process
      c.connection?.stream?.destroy?.()
    } catch { /* already gone */ }
  }
}
