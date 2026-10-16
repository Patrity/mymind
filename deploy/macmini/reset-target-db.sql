-- Empty the restore target for a retry (cycle 86 cutover, CUTOVER.md "Abort / undo").
-- Run by reset-target-db.sh as the NON-superuser target role, with psql variables:
--   schema  the schema to empty (public)        ledger  the migrations-ledger schema to drop (drizzle)
-- Drops ONLY objects the connecting role owns that are NOT extension members (pg_depend deptype 'e'):
-- the superuser-owned extensions (vector, pg_trgm, ltree, pgcrypto) and everything that belongs to
-- them stay. Never `drop owned` — that also revokes the role's grants. One transaction.
\set ON_ERROR_STOP 1
begin;

drop schema if exists :"ledger" cascade;

-- Relations: views and matviews first, then tables and foreign tables, then sequences. A serial or
-- identity sequence is dropped with its table (same owner, by definition), so its own later
-- `drop sequence if exists` is a no-op. Indexes, toast etc. go with their tables.
select format('drop %s if exists %I.%I cascade',
         case c.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence'
                        when 'f' then 'foreign table' else 'table' end,
         n.nspname, c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema'
  and c.relkind in ('v', 'm', 'r', 'p', 'f', 'S')
  and pg_get_userbyid(c.relowner) = current_user
  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  and not (c.relkind in ('r', 'p') and c.relispartition)
order by case c.relkind when 'v' then 0 when 'm' then 1 when 'S' then 3 else 2 end, c.relname
\gexec

-- Routines (functions, procedures, aggregates, window functions).
select format('drop %s if exists %s cascade',
         case p.prokind when 'a' then 'aggregate' when 'p' then 'procedure' else 'function' end,
         p.oid::regprocedure)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = :'schema'
  and pg_get_userbyid(p.proowner) = current_user
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
order by p.prokind = 'a' desc, p.oid
\gexec

-- Standalone types: enums, domains, ranges, standalone composites (not a table's row type, not an
-- implicit array type).
select format('drop %s if exists %I.%I cascade', case t.typtype when 'd' then 'domain' else 'type' end, n.nspname, t.typname)
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where n.nspname = :'schema'
  and t.typtype in ('e', 'd', 'r', 'c')
  and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
  and pg_get_userbyid(t.typowner) = current_user
  and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
order by t.typname
\gexec

-- What is left that this role owns in the schema must be nothing.
select format('reset-target-db: %s object(s) owned by %s remain in %s', count(*), current_user, :'schema') as leftover,
       count(*) = 0 as clean
from (
  select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = :'schema' and pg_get_userbyid(c.relowner) = current_user and c.relkind in ('v','m','r','p','f','S')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  union all
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = :'schema' and pg_get_userbyid(p.proowner) = current_user
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
) left_over \gset
\if :clean
\else
  \echo :leftover
  \echo 'reset-target-db: rolling back'
  rollback;
  do $$ begin raise exception 'reset-target-db: objects remain — nothing was dropped'; end $$;
\endif
commit;
\echo 'reset-target-db: done'
