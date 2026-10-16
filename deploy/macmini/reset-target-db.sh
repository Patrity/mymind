#!/usr/bin/env bash
# Reset the cutover's restore target (192.168.2.80/bridget) to empty, for a retry of the restore
# (CUTOVER.md "Abort / undo during the window", and the way back to the mini after a rollback).
#
# Drops the `drizzle` ledger schema, then every relation, routine and standalone type in `public`
# OWNED BY THE CONNECTING ROLE that is not an extension member (pg_depend deptype 'e') — see
# reset-target-db.sql. The superuser-owned extensions stay; never `drop owned` (it revokes grants).
# One transaction; it rolls back if anything the role owns would remain.
#
# Refuses unless BOTH: `--i-know` is passed, and the DSN's host is 192.168.2.80 and its database is
# `bridget`. Never prints the DSN.
#
# Usage: reset-target-db.sh --i-know <DSN>
#   ( set -a; . /opt/mymind-build/.env.macmini; set +a; bash /root/reset-target-db.sh --i-know "$DATABASE_URL" )
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PSQL="${MYMIND_PSQL:-psql}"
TARGET_HOST=192.168.2.80
TARGET_DB=bridget

[ "${1:-}" = --i-know ] && [ "$#" -eq 2 ] || { echo "usage: $0 --i-know <DSN>  (empties public + drizzle on $TARGET_HOST/$TARGET_DB)" >&2; exit 2; }
dsn="$2"
# postgres[ql]://[user[:pw]@]host[:port]/db[?params] — the URL form only (a keyword DSN is refused).
host="$(printf '%s' "$dsn" | sed -nE 's#^postgres(ql)?://([^@/]*@)?([^:/?]+)(:[0-9]+)?/([^?]*).*#\3#p')"
db="$(printf '%s' "$dsn" | sed -nE 's#^postgres(ql)?://([^@/]*@)?([^:/?]+)(:[0-9]+)?/([^?]*).*#\5#p')"
if [ "$host" != "$TARGET_HOST" ] || [ "$db" != "$TARGET_DB" ]; then
  echo "[reset] refusing: the DSN points at host '${host:-?}' database '${db:-?}', not $TARGET_HOST/$TARGET_DB" >&2
  exit 2
fi
SQL="${MYMIND_RESET_SQL:-$HERE/reset-target-db.sql}"
[ -r "$SQL" ] || { echo "[reset] $SQL missing (copy it next to this script)" >&2; exit 2; }
echo "[reset] emptying public + drizzle on $TARGET_HOST/$TARGET_DB (objects owned by the DSN's role only)"
"$PSQL" "$dsn" -X -q -v ON_ERROR_STOP=1 -v schema=public -v ledger=drizzle -f "$SQL"
