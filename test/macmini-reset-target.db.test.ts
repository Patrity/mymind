// Cycle 86 cutover (re-review R1): deploy/macmini/reset-target-db.sql — the object selection that empties
// the restore target for a retry — run against a SCRATCH schema on the dev DB (never .80). It must drop
// what the connecting role owns (tables, views, sequences, routines, standalone types, the ledger schema)
// and keep extension members and objects another role owns. The wrapper's refusals are in
// test/macmini-cutover.test.ts.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.loadEnvFile('.env')
const DSN = process.env.DATABASE_URL!
const tag = randomBytes(4).toString('hex')
const S = `mm_reset_${tag}`
const L = `mm_reset_ledger_${tag}`
const R = `mm_reset_role_${tag}`

function psql(args: string[], input?: string) {
  const r = spawnSync('psql', [DSN, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr }
}
const q = (sql: string) => {
  const r = psql(['-c', sql])
  if (r.code !== 0) throw new Error(r.err)
  return r.out ? r.out.split('\n') : []
}

beforeAll(() => {
  const setup = `
    create role ${R} nologin;
    create schema ${S}; create schema ${L};
    create table ${L}.__drizzle_migrations (id int);
    grant usage, create on schema ${S} to ${R};
    create extension hstore schema ${S};
    create type ${S}.mood as enum ('a', 'b');
    create domain ${S}.posint as int check (value > 0);
    create type ${S}.pair as (a int, b int);
    create table ${S}.t1 (id serial primary key, m ${S}.mood, h ${S}.hstore, n ${S}.posint);
    create table ${S}.t2 (id int generated always as identity, ref int references ${S}.t1 (id));
    create view ${S}.v1 as select * from ${S}.t1;
    create materialized view ${S}.mv1 as select id from ${S}.t1;
    create sequence ${S}.free_seq;
    create table ${S}.part (k int) partition by range (k);
    create table ${S}.part_1 partition of ${S}.part for values from (0) to (10);
    create function ${S}.f1(x int) returns int language sql as 'select x';
    create procedure ${S}.p1() language sql as 'select 1';
    create aggregate ${S}.agg1(int) (sfunc = int4pl, stype = int);
    set role ${R};
    create table ${S}.theirs (id int);
    create function ${S}.their_fn() returns int language sql as 'select 2';
    reset role;`
  const r = psql([], setup)
  if (r.code !== 0) throw new Error(r.err)
})

afterAll(() => {
  psql([], `drop schema if exists ${S} cascade; drop schema if exists ${L} cascade; drop owned by ${R}; drop role if exists ${R};`)
})

describe('reset-target-db.sql (scratch schema on the dev DB)', () => {
  it('drops only the role\'s own non-extension objects and the ledger schema, in one go', () => {
    const extFns = Number(q(`select count(*) from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' where p.pronamespace = '${S}'::regnamespace`)[0])
    expect(extFns).toBeGreaterThan(10) // hstore's functions live in the scratch schema, owned by this role

    const r = psql(['-q', '-v', `schema=${S}`, '-v', `ledger=${L}`, '-f', resolve('deploy/macmini/reset-target-db.sql')])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('reset-target-db: done')

    expect(q(`select nspname from pg_namespace where nspname = '${L}'`)).toEqual([])
    // Relations left: only the other role's table.
    expect(q(`select relname from pg_class where relnamespace = '${S}'::regnamespace and relkind in ('r','p','v','m','S','f') order by 1`)).toEqual(['theirs'])
    // Routines left: the extension's members + the other role's function — none of ours.
    expect(q(`select proname from pg_proc where pronamespace = '${S}'::regnamespace and proname in ('f1','p1','agg1','their_fn') order by 1`)).toEqual(['their_fn'])
    expect(Number(q(`select count(*) from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' where p.pronamespace = '${S}'::regnamespace`)[0])).toBe(extFns)
    // Types left: the extension's (hstore and its array), and the other role's table row type — not ours.
    expect(q(`select typname from pg_type where typnamespace = '${S}'::regnamespace and typname in ('mood','posint','pair','hstore') order by 1`)).toEqual(['hstore'])
    expect(q(`select extname from pg_extension where extnamespace = '${S}'::regnamespace`)).toEqual(['hstore'])
  })

  it('is idempotent: a second run on an emptied schema succeeds and changes nothing', () => {
    const r = psql(['-q', '-v', `schema=${S}`, '-v', `ledger=${L}`, '-f', resolve('deploy/macmini/reset-target-db.sql')])
    expect(r.code, r.err).toBe(0)
    expect(q(`select relname from pg_class where relnamespace = '${S}'::regnamespace and relkind in ('r','p','v','m','S','f')`)).toEqual(['theirs'])
  })
})
