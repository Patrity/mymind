#!/usr/bin/env bash
# launchd entry point for MyMind on the Mac mini (cycle 86): `run.sh web|worker`.
# Installed to ~/mymind/bin/run.sh by provision-macmini.sh; com.mymind.{web,worker}.plist run it.
#
# launchd cannot source an env file, so this does: it exports ~/mymind/env/mymind.env (never printed),
# sets what launchd's minimal environment lacks (Homebrew PATH, NODE_ENV, the open-files limit), sends
# stdout+stderr to a size-rotated ~/Library/Logs/mymind/<kind>.log, and finally EXECs node — so node
# is the job's main process and gets launchd's SIGTERM directly (the worker drains on it).
set -euo pipefail

KIND="${1:-}"
ROOT="${MYMIND_ROOT:-$HOME/mymind}"
ENV_FILE="${MYMIND_ENV_FILE:-$ROOT/env/mymind.env}"
LOG_DIR="${MYMIND_LOG_DIR:-$HOME/Library/Logs/mymind}"
NODE="${MYMIND_NODE:-/opt/homebrew/bin/node}"
LOG_MAX_BYTES="${MYMIND_LOG_MAX_BYTES:-52428800}"   # 50 MB per file …
LOG_KEEP="${MYMIND_LOG_KEEP:-5}"                    # … × 5 rotated files
FAIL_SLEEP="${MYMIND_RUN_FAIL_SLEEP:-10}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

case "$KIND" in
  web)    DIR="$ROOT/app";     ENTRY=.output/server/index.mjs; HEAP=1536 ;;
  worker) DIR="$ROOT/.worker"; ENTRY=dist/worker.mjs;          HEAP=2048 ;;
  *) echo "usage: run.sh web|worker" >&2; exit 64 ;;
esac

# A missing env file or release is not fixed by an instant respawn: wait out launchd's throttle.
if [ ! -r "$ENV_FILE" ]; then echo "[run] $ENV_FILE missing or unreadable" >&2; sleep "$FAIL_SLEEP"; exit 78; fi
if [ ! -f "$DIR/$ENTRY" ]; then echo "[run] no active $KIND release ($DIR/$ENTRY)" >&2; sleep "$FAIL_SLEEP"; exit 78; fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export NODE_ENV=production

# The physical release dir: a later activate repoints the symlink, never this process's tree.
cd -P "$DIR"
# The commit this release was built from (build-artifacts.sh ships it; optional): the worker records it
# on eval runs (cycle 85), the web reports it on /api/health for CD's gate (cycle 86).
if [ -f release.env ]; then set -a; . ./release.env; set +a; fi
if [ "$KIND" = worker ]; then
  # The only executor on the prod DB (boot recovery may take over any 'running' run).
  export AGENT_RUNTIME_EXCLUSIVE=1
  # Built-in eval suites ship inside the worker release.
  export MYMIND_EVALS_DIR="$PWD/evals"
fi

# launchd's default soft limit is 256 open files — too few for a server with a pg pool.
ulimit -n 10240 2>/dev/null || true

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$KIND.log"

# Appends stdin to $1, rotating $1 → $1.1 → … → $1.$LOG_KEEP once it passes $LOG_MAX_BYTES (checked
# every 100 lines). launchd's own StandardOutPath can't rotate under a running process; this can.
rotate_log() {
  set +e   # a failed rotation must never kill the pipe node writes to
  # launchd signals the whole job on stop: keep reading until node's EOF so its drain lines land.
  trap '' TERM INT HUP
  local f="$1" n=0 i line
  exec 3>>"$f"
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >&3
    n=$((n + 1))
    if [ $((n % 100)) -eq 0 ] && [ "$(wc -c < "$f" | tr -d ' ')" -gt "$LOG_MAX_BYTES" ]; then
      exec 3>&-
      rm -f "$f.$LOG_KEEP"
      for ((i = LOG_KEEP - 1; i >= 1; i--)); do [ -f "$f.$i" ] && mv "$f.$i" "$f.$((i + 1))"; done
      mv "$f" "$f.1"
      exec 3>>"$f"
    fi
  done
}

exec > >(rotate_log "$LOG") 2>&1
echo "[run] $(date '+%Y-%m-%dT%H:%M:%S%z') starting $KIND from $PWD (heap ${HEAP} MB)"
exec "$NODE" --max-old-space-size="$HEAP" "$ENTRY"
