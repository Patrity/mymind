#!/usr/bin/env bash
# Cutover check (cycle 86 final wave I1): exact row counts, table by table, in two databases — the old
# LXC 114 database and the restored 192.168.2.80/bridget. Prints every mismatch (and every table that
# exists on only one side), then a summary; exits 1 on any difference.
#
# Usage: compare-counts.sh <source DSN> <target DSN>
#   Run it in LXC 114 with the DSNs read from the env files in a subshell, so no URL is typed or echoed:
#     ( set -a; . /opt/mymind/.env.native; SRC=$DATABASE_URL; . /opt/mymind-build/.env.macmini; set +a
#       bash /root/compare-counts.sh "$SRC" "$DATABASE_URL" )      (deploy/macmini/CUTOVER.md, step W4)
# Never prints a DSN. Counts are exact (count(*)), not pg_class estimates.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: $0 <source DSN> <target DSN>" >&2; exit 2; }
PSQL="${MYMIND_PSQL:-psql}"
export LC_ALL=C   # sort and join must agree on the order

# One row per base table outside the system schemas: "<schema>.<table>|<count>".
SQL="select format('%s.%s|%s', table_schema, table_name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text)
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_toast%'
order by 1"

counts() { # <dsn> <label>
  local out
  if ! out="$("$PSQL" "$1" -X -At -v ON_ERROR_STOP=1 -c "$SQL" 2>&1)"; then
    # psql's error text can echo connection parameters: report only that it failed.
    echo "[compare] could not read row counts from the $2 database" >&2
    exit 2
  fi
  printf '%s\n' "$out" | grep -E '^[^|]+\|[0-9]+$' | sort -t '|' -k1,1 || true
}

src="$(counts "$1" source)"
dst="$(counts "$2" target)"
[ -n "$src" ] || { echo "[compare] the source database has no tables — wrong DSN?" >&2; exit 2; }

report="$(join -t '|' -a 1 -a 2 -e MISSING -o 0,1.2,2.2 <(printf '%s\n' "$src") <(printf '%s\n' "$dst"))"
tables=0; bad=0
while IFS='|' read -r table a b; do
  [ -n "$table" ] || continue
  tables=$((tables + 1))
  if [ "$a" != "$b" ]; then
    bad=$((bad + 1))
    printf '[MISMATCH] %-50s source=%s target=%s\n' "$table" "$a" "$b"
  fi
done <<< "$report"

if [ "$bad" -eq 0 ]; then echo "[compare] $tables tables, every row count matches"; exit 0; fi
echo "[compare] $bad of $tables tables differ"
exit 1
