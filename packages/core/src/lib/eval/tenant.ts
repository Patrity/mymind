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
  await outsideEvalScope(async () => {
    const tables = await shadowableTables()
    await adminDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`create schema ${s}`))
      for (const t of tables) {
        await tx.execute(sql.raw(`create table ${s}.${ident(t)} (like public.${ident(t)} including all)`))
      }
      for (const t of EVAL_REFERENCE_TABLES) {
        if (!tables.includes(t)) continue
        const cols = await tx.execute(sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${t} and is_generated = 'NEVER' order by ordinal_position`)
        const list = (cols.rows as { column_name: string }[]).map(c => `"${c.column_name.replace(/"/g, '""')}"`).join(', ')
        if (list) await tx.execute(sql.raw(`insert into ${s}.${ident(t)} (${list}) select ${list} from public.${ident(t)}`))
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
  const pool = new pg.Pool({
    connectionString: coreConfig().databaseUrl,
    max: 4,
    options: `-c search_path=${schema},public`
  })
  pool.on('error', err => console.error(`[eval] tenant ${schema} idle client error:`, err.message))
  return { schema, pool }
}

/** `FOREIGN KEY (x) REFERENCES [public.]t(id) …` → `… REFERENCES "<schema>".t(id) …` (an `eval_*`
 *  target stays in public). */
export function retargetForeignKey(def: string, schema: string): string {
  return def.replace(/REFERENCES\s+(?:public\.)?("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(/, (_m, q: string, table: string) =>
    isUnshadowedTable(table) ? `REFERENCES public.${q}${table}${q}(` : `REFERENCES "${schema}".${q}${table}${q}(`)
}

/** Ends the world's pool and drops its schema. Idempotent. */
export async function dropEvalTenant(t: EvalTenant): Promise<void> {
  const schema = assertSchema(t.schema)
  await t.pool.end().catch(() => {})
  await outsideEvalScope(() => adminDb().execute(sql.raw(`drop schema if exists ${ident(schema)} cascade`)))
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
  for (const n of mine) {
    await outsideEvalScope(() => adminDb().execute(sql.raw(`drop schema if exists ${ident(assertSchema(n))} cascade`)))
  }
  return mine.length
}
