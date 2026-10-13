#!/usr/bin/env bash
# MyMind releases on the Mac mini (cycle 86) — web (.output) and agent worker, one pattern for both.
# Installed to ~/mymind/bin/release.sh by provision-macmini.sh; CD calls it over ssh.
#
#   stage    <web|worker> <id>   untar a release from STDIN into releases/<kind>-<id>, check it (entry
#                                file, darwin native binaries, externals load) and point <next> at it
#   activate <web|worker>        <next> becomes <current>, the old <current> becomes <prev>
#   rollback <web|worker>        <prev> becomes <current>, the old <current> becomes <next>
#   restart  <web|worker>        restart the launchd agent and wait for a NEW pid: kickstart -k, or — when
#                                provision left a changed plist pending — bootout, wait for the exit,
#                                install it, bootstrap (retried: "Bootstrap failed: 5" while it exits)
#   health   <worker> [s]        the worker launchd runs NOW (a pid other than the one `restart` replaced)
#                                has a heartbeat row on the DB that started after that restart, < 30 s old
#   undo     <web|worker> <rel>  roll back + restart, but only while <current> is exactly release <rel>
#                                (CD's failure step: never rolls back a release this deploy didn't activate)
#   status                       print where each pointer points
#
# Pointers are SYMLINKS under $MYMIND_ROOT (default ~/mymind), each swapped with one rename(2), so a
# launchd (re)start never finds a half-moved tree:
#   web:    app         .app-prev      .app-next        -> releases/web-<id>
#   worker: .worker     .worker-prev   .worker-next     -> releases/worker-<id>
# A running process keeps its cwd (the old release's real dir) until it is restarted. Releases no
# pointer references are pruned on stage and activate. Never sources the env file except in `health`,
# and never prints it.
set -euo pipefail

ROOT="${MYMIND_ROOT:-$HOME/mymind}"
REL="$ROOT/releases"
NODE="${MYMIND_NODE:-/opt/homebrew/bin/node}"
PSQL="${MYMIND_PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
ENV_FILE="${MYMIND_ENV_FILE:-$ROOT/env/mymind.env}"
LAUNCH_AGENTS="${MYMIND_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
# Plists provision-macmini.sh rendered but could not install (their agent was running): applied by restart.
PENDING="${MYMIND_PENDING_AGENTS:-$ROOT/deploy/agents}"
POLL="${MYMIND_POLL_SECONDS:-5}"
RESTART_WAIT="${MYMIND_RESTART_WAIT:-120}"   # > the worker's ExitTimeOut (90)

die() { echo "[release] $*" >&2; exit 1; }
say() { echo "[release] $*"; }

# kind → pointer names, entry file and launchd label
ptrs() {
  case "$1" in
    web)    CUR=app;     PREV=.app-prev;    NEXT=.app-next;    ENTRY=.output/server/index.mjs ;;
    worker) CUR=.worker; PREV=.worker-prev; NEXT=.worker-next; ENTRY=dist/worker.mjs ;;
    *) die "unknown kind '$1' (web|worker)" ;;
  esac
  LABEL="com.mymind.$1"
}

# The release dir a pointer resolves to ('' when unset or dangling).
target() {
  local p="$ROOT/$1"
  if [ -L "$p" ] && [ -d "$p" ]; then (cd -P "$p" && pwd); fi
  return 0
}

# Point $1 at $2 (relative releases/<name>, or '' to remove) with one atomic rename.
point() {
  local name="$1" dest="$2" tmp="$ROOT/.$1.swap.$$"
  if [ -z "$dest" ]; then rm -f "$ROOT/$name"; return 0; fi
  if [ -e "$ROOT/$name" ] && [ ! -L "$ROOT/$name" ]; then die "$ROOT/$name is a real directory, not a release pointer — move it aside first"; fi
  rm -f "$tmp"
  ln -s "$dest" "$tmp"
  # rename(2) over the old symlink: atomic, and never descends into it (mv would, for a dir link).
  perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename $ARGV[0] -> $ARGV[1]: $!\n"' "$tmp" "$ROOT/$name"
}

# 'releases/<name>' for a resolved release dir.
rel_of() { [ -n "$1" ] && echo "releases/$(basename "$1")" || true; }

prune() {
  local keep=" " d b p
  for p in app .app-prev .app-next .worker .worker-prev .worker-next; do
    d="$(target "$p")"; [ -n "$d" ] && keep+="$(basename "$d") "
  done
  [ -d "$REL" ] || return 0
  for d in "$REL"/* "$REL"/.*.incoming; do
    [ -e "$d" ] || continue
    b="$(basename "$d")"
    case "$keep" in *" $b "*) ;; *) rm -rf "$d" ;; esac
  done
}

# Every linux native package the build box installed for itself needs its darwin-arm64 twin
# (pnpm-workspace.yaml supportedArchitectures), or sharp / @napi-rs/canvas fail at runtime here.
check_natives() {
  local dir="$1" missing=0 d twin
  # Inside a pnpm store entry (.pnpm/<entry>/…) the package is the entry itself: prune below it.
  while IFS= read -r d; do
    twin="$(basename "$d" | sed -E 's/-linux-x64(-gnu)?(@|$)/-darwin-arm64\2/')"
    if [ ! -d "$(dirname "$d")/$twin" ]; then echo "[release] no darwin-arm64 twin for ${d#"$dir"/}" >&2; missing=1; fi
  done < <(find "$dir" -path '*/.pnpm/*/*' -prune -o -type d \( -name '*-linux-x64' -o -name '*-linux-x64@*' \
             -o -name '*-linux-x64-gnu' -o -name '*-linux-x64-gnu@*' \) -print)
  return "$missing"
}

# Load the release's native/external packages with THIS machine's node.
check_loads() {
  local kind="$1" dir="$2" probe pkgs=() f
  # Every darwin native binary must load here — sharp's, @napi-rs/canvas's (pdfjs only WARNS when that
  # one fails, so an import probe can't see it), and any future native.
  while IFS= read -r f; do
    "$NODE" -e 'process.dlopen({ exports: {} }, process.argv[1])' "$f" >/dev/null 2>&1 \
      || { echo "[release] native binary does not load: ${f#"$dir"/}" >&2; return 1; }
  done < <(find "$dir" -type f -name '*.node' -path '*darwin-arm64*')
  if [ "$kind" = web ]; then
    [ -d "$dir/.output/server/node_modules/sharp" ] || return 0
    (cd "$dir/.output/server" && "$NODE" --input-type=module -e 'await import("sharp")') >/dev/null \
      || { echo "[release] sharp does not load from the web release" >&2; return 1; }
    return 0
  fi
  [ -d "$dir/node_modules" ] || return 0
  local e
  for e in "$dir"/node_modules/* "$dir"/node_modules/@*/*; do
    [ -e "$e" ] || continue
    case "$(basename "$e")" in .*) continue ;; esac
    [ -L "$e" ] || [ -d "$e" ] || continue
    pkgs+=("${e#"$dir"/node_modules/}")
  done
  [ ${#pkgs[@]} -gt 0 ] || return 0
  probe="$dir/dist/.verify-externals.mjs"
  : > "$probe"
  for e in "${pkgs[@]}"; do printf 'await import(%s)\n' "\"$e\"" >> "$probe"; done
  if ! "$NODE" "$probe" >/dev/null; then rm -f "$probe"; echo "[release] the worker's externals do not load: ${pkgs[*]}" >&2; return 1; fi
  rm -f "$probe"
}

cmd_stage() {
  local kind="$1" id="$2"
  ptrs "$kind"
  case "$id" in ''|*/*|.*) die "bad release id '$id'" ;; esac
  mkdir -p "$REL"
  prune
  local dir="$REL/$kind-$id" tmp="$REL/.$kind-$id.incoming"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -x -C "$tmp" -f - || { rm -rf "$tmp"; die "untar failed"; }
  [ -f "$tmp/$ENTRY" ] || { rm -rf "$tmp"; die "$kind release has no $ENTRY"; }
  check_natives "$tmp" || { rm -rf "$tmp"; die "$kind release lacks darwin-arm64 native binaries"; }
  check_loads "$kind" "$tmp" || { rm -rf "$tmp"; die "$kind release failed its load check"; }
  # Never overwrite a release a pointer still uses (a re-deploy of the same id gets a suffix).
  if [ -e "$dir" ]; then dir="$dir.$(date +%s)"; fi
  mv "$tmp" "$dir"
  point "$NEXT" "releases/$(basename "$dir")"
  say "staged $kind → $(basename "$dir") ($NEXT)"
}

cmd_activate() {
  ptrs "$1"
  local next cur
  next="$(target "$NEXT")"; cur="$(target "$CUR")"
  [ -n "$next" ] && [ -f "$next/$ENTRY" ] || die "no staged $1 release ($NEXT) — stage first"
  # prev first: if we die between the two renames, current is still the old, whole release.
  if [ -n "$cur" ]; then point "$PREV" "$(rel_of "$cur")"; fi
  point "$CUR" "$(rel_of "$next")"
  point "$NEXT" ''
  prune
  say "activated $1 → $(basename "$next") (previous: $( [ -n "$cur" ] && basename "$cur" || echo none ))"
}

cmd_rollback() {
  ptrs "$1"
  local prev cur
  prev="$(target "$PREV")"; cur="$(target "$CUR")"
  [ -n "$prev" ] && [ -f "$prev/$ENTRY" ] || die "no previous $1 release to roll back to"
  if [ -n "$cur" ]; then point "$NEXT" "$(rel_of "$cur")"; fi
  point "$CUR" "$(rel_of "$prev")"
  point "$PREV" ''
  say "rolled $1 back → $(basename "$prev") ($NEXT holds the release that was active)"
}

pid_of() { launchctl print "gui/$(id -u)/$1" 2>/dev/null | awk '$1 == "pid" { print $3; exit }'; }
loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }

bootstrap_retry() { # <plist>
  local i
  for i in 1 2 3 4 5 6; do
    if launchctl bootstrap "gui/$(id -u)" "$1" 2>/dev/null; then return 0; fi
    sleep "$POLL"
  done
  return 1
}

cmd_restart() {
  ptrs "$1"
  local svc plist pending old pid i
  svc="gui/$(id -u)/$LABEL"; plist="$LAUNCH_AGENTS/$LABEL.plist"; pending="$PENDING/$LABEL.plist"
  old="$(pid_of "$LABEL" || true)"
  # What `health` compares against: the pid being replaced and when (epoch seconds, this clock).
  printf '%s %s\n' "$(date +%s)" "${old:-0}" > "$ROOT/.restarted-$1"
  if [ -f "$pending" ] && ! cmp -s "$pending" "$plist"; then
    if loaded "$LABEL"; then
      launchctl bootout "$svc" 2>/dev/null || true
      i=$((SECONDS + RESTART_WAIT)); while loaded "$LABEL" && [ "$SECONDS" -lt "$i" ]; do sleep "$POLL"; done
      loaded "$LABEL" && die "$LABEL still loaded ${RESTART_WAIT}s after bootout"
    fi
    install -m 644 "$pending" "$plist"
    bootstrap_retry "$plist" || die "bootstrap of $LABEL failed (agent NOT loaded)"
    say "reloaded $LABEL with its changed plist"
  elif loaded "$LABEL"; then
    # SIGTERM, then SIGKILL after the plist's ExitTimeOut (the worker drains in-flight runs ≤ 60 s).
    launchctl kickstart -k "$svc"
    say "kickstarted $LABEL"
  else
    [ -f "$plist" ] || die "$plist missing — run provision-macmini.sh"
    bootstrap_retry "$plist" || die "bootstrap of $LABEL failed (agent NOT loaded)"
    say "bootstrapped $LABEL"
  fi
  # Done only when launchd runs a NEW process (kickstart -k may return before the old one exits).
  i=$((SECONDS + RESTART_WAIT))
  while :; do
    pid="$(pid_of "$LABEL" || true)"
    if [ -n "$pid" ] && [ "$pid" != "$old" ]; then say "$LABEL running as pid $pid (was ${old:-none})"; return 0; fi
    [ "$SECONDS" -lt "$i" ] || break
    sleep "$POLL"
  done
  loaded "$LABEL" || die "$LABEL is not loaded"
  die "$LABEL has no new pid within ${RESTART_WAIT}s (still ${pid:-none})"
}

# The worker launchd runs now — not the pid `restart` replaced — wrote a heartbeat row that started
# after that restart (5 s clock slack) on this host, beating < 30 s ago. Polls up to $2 seconds.
cmd_health() {
  [ "$1" = worker ] || die "health: only 'worker' (the web is checked over HTTP)"
  local pid n wait="${2:-60}" host since old
  host="$(hostname)"
  [ -r "$ENV_FILE" ] || die "$ENV_FILE unreadable"
  [ -r "$ROOT/.restarted-worker" ] || die "no restart recorded — run release.sh restart worker first"
  read -r since old < "$ROOT/.restarted-worker"
  local deadline=$((SECONDS + wait))
  while :; do
    pid="$(pid_of com.mymind.worker || true)"
    if [ -n "$pid" ] && [ "$pid" != "$old" ]; then
      # Sourced in a subshell for the DB URL only; never echoed.
      n="$( (set -a; . "$ENV_FILE"; set +a; "$PSQL" "${NUXT_DATABASE_URL:-$DATABASE_URL}" -Atc \
        "select count(*) from worker_heartbeat where pid = $pid and host = '$host' and started_at > to_timestamp($since) - interval '5 seconds' and beat_at > now() - interval '30 seconds'") 2>/dev/null || echo 0)"
      if [ "${n:-0}" -gt 0 ] 2>/dev/null; then say "worker healthy (pid $pid)"; return 0; fi
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    say "waiting for the worker heartbeat (pid ${pid:-none}, replaced ${old})"; sleep "$POLL"
  done
  die "no fresh heartbeat from a new worker within ${wait}s"
}

cmd_undo() {
  ptrs "$1"
  local cur; cur="$(target "$CUR")"
  if [ -z "$cur" ] || [ "$(basename "$cur")" != "$2" ]; then say "undo $1: current is $( [ -n "$cur" ] && basename "$cur" || echo none ), not $2 — nothing to undo"; return 0; fi
  cmd_rollback "$1"
  cmd_restart "$1"
}

cmd_status() {
  local p
  for p in app .app-prev .app-next .worker .worker-prev .worker-next; do
    printf '%-13s %s\n' "$p" "$( d="$(target "$p")"; [ -n "$d" ] && basename "$d" || echo - )"
  done
}

case "${1:-}" in
  stage)    [ $# -eq 3 ] || die "usage: stage <web|worker> <id>  (tar on stdin)"; cmd_stage "$2" "$3" ;;
  activate) [ $# -eq 2 ] || die "usage: activate <web|worker>"; cmd_activate "$2" ;;
  rollback) [ $# -eq 2 ] || die "usage: rollback <web|worker>"; cmd_rollback "$2" ;;
  restart)  [ $# -eq 2 ] || die "usage: restart <web|worker>"; cmd_restart "$2" ;;
  health)   [ $# -ge 2 ] || die "usage: health worker [seconds]"; cmd_health "$2" "${3:-60}" ;;
  undo)     [ $# -eq 3 ] || die "usage: undo <web|worker> <release>"; cmd_undo "$2" "$3" ;;
  status)   cmd_status ;;
  *) echo "usage: $0 stage|activate|rollback|restart|health|undo|status …" >&2; exit 2 ;;
esac
