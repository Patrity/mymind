#!/usr/bin/env bash
# Idempotent provisioning of the MyMind host on the Mac mini (cycle 86) — run as bridget, never root.
#
#   provision-macmini.sh           fix what it can (dirs, ripgrep/libpq, ~/mymind/bin scripts, launchd
#                                  plists), fail on what it must not touch (env values, Node, Hermes)
#   provision-macmini.sh --check   READ-ONLY: report the same items, change nothing; exit 1 on any FAIL
#
# CD runs it from ~/mymind/deploy/ on every macmini deploy (deploy.yml). It never prints an env value:
# the env file (~/mymind/env/mymind.env, written once by hand) is grepped for key NAMES and the DB host.
# It never touches BlueBubbles or node_exporter, and never starts a service that isn't running yet
# (release.sh restart bootstraps it after the first release is activated).
set -euo pipefail

CHECK=0
case "${1:-}" in --check) CHECK=1 ;; '') ;; *) echo "usage: $0 [--check]" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${MYMIND_ROOT:-$HOME/mymind}"
ENV_FILE="$ROOT/env/mymind.env"
LOG_DIR="$HOME/Library/Logs/mymind"
AGENTS="$HOME/Library/LaunchAgents"
BREW=/opt/homebrew/bin/brew
DB_HOST=192.168.2.80
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

FAILS=0
ok()   { echo "[ok]   $*"; }
fix()  { echo "[fix]  $*"; }
warn() { echo "[warn] $*"; }
fail() { echo "[FAIL] $*"; FAILS=$((FAILS + 1)); }
# would-fix in --check mode, fix otherwise: `act "<what>" <command…>`
act() { local what="$1"; shift; if [ "$CHECK" = 1 ]; then fail "$what (would fix)"; else "$@"; fix "$what"; fi; }

echo "[provision] $(hostname) — $( [ "$CHECK" = 1 ] && echo 'check (read-only)' || echo apply )"

# 0. Who/where
[ "$(uname -s)" = Darwin ] || { echo "[FAIL] not macOS"; exit 1; }
[ "$(id -u)" != 0 ] || { echo "[FAIL] run as bridget, not root (LaunchAgents are per-user)"; exit 1; }
ok "user $(id -un) (uid $(id -u)), macOS $(sw_vers -productVersion), $(uname -m)"

# 1. Boot survival: the LaunchAgents run in bridget's GUI session, which exists after a reboot only with
#    autologin; sleep would stall the services.
autologin="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
if [ "$autologin" = "$(id -un)" ]; then ok "autologin user is $autologin"; else fail "autologin user is '${autologin:-unset}', not $(id -un) — LaunchAgents won't start after a reboot"; fi
if pmset -g 2>/dev/null | grep -qE '^ sleep +0( |$)'; then ok "system sleep disabled"; else warn "system sleep is not 0 (pmset -g) — the services pause while the mini sleeps"; fi

# 2. Homebrew + tools. Node is never auto-installed (the major is pinned to 22 by hand).
if [ -x "$BREW" ]; then ok "homebrew at $BREW"; else fail "homebrew missing at $BREW"; fi
if [ -x /opt/homebrew/bin/node ] && [ "$(/opt/homebrew/bin/node -v | cut -d. -f1)" = v22 ]; then
  ok "node $(/opt/homebrew/bin/node -v)"
else
  fail "/opt/homebrew/bin/node missing or not v22 (brew install node@22 && brew link --overwrite node@22)"
fi
brew_tool() { # <binary path> <formula>
  if [ -x "$1" ]; then ok "$2 ($1)"
  elif [ -x "$BREW" ]; then act "brew install $2" "$BREW" install --quiet "$2"
  else fail "$2 missing and no homebrew"; fi
}
brew_tool /opt/homebrew/bin/rg ripgrep                 # the workspace grep tool
brew_tool /opt/homebrew/opt/libpq/bin/psql libpq       # release.sh health (worker heartbeat)
if command -v git >/dev/null 2>&1; then ok "git ($(command -v git))"; else warn "git missing (agent workspace commands use it)"; fi

# 3. Hermes is retired: nothing of it may be loaded, and :3000 must be free for (or held by) MyMind.
hermes="$(launchctl list 2>/dev/null | awk '{print $3}' | grep -i hermes || true)"
if [ -z "$hermes" ]; then ok "no hermes launchd job loaded"; else fail "hermes job(s) still loaded: $(echo "$hermes" | tr '\n' ' ')— retire them first"; fi
if ls "$AGENTS" 2>/dev/null | grep -qi hermes; then warn "a hermes plist remains in $AGENTS (not loaded)"; fi
holder="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1 || true)"
if [ -z "$holder" ]; then ok ":3000 free"
elif launchctl list 2>/dev/null | awk '{print $3}' | grep -qx com.mymind.web; then ok ":3000 held by com.mymind.web ($holder)"
else fail ":3000 is held by '$holder', not com.mymind.web"; fi

# 4. Directories
for d in "$ROOT" "$ROOT/releases" "$ROOT/bin" "$ROOT/deploy" "$ROOT/data/uploads" "$ROOT/workspaces" \
         "$ROOT/evals-scratch" "$LOG_DIR" "$AGENTS"; do
  if [ -d "$d" ]; then ok "dir $d"; else act "mkdir $d" mkdir -p "$d"; fi
done
if [ -d "$ROOT/env" ]; then
  if [ "$(stat -f %Lp "$ROOT/env")" = 700 ]; then ok "dir $ROOT/env (700)"; else act "chmod 700 $ROOT/env" chmod 700 "$ROOT/env"; fi
else act "mkdir -m 700 $ROOT/env" mkdir -m 700 "$ROOT/env"; fi

# 5. The env file: written once by hand (never by this script), mode 600, the required keys present.
#    Only key NAMES and the DB host are inspected — never a value.
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//" || true; }
if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE missing — write it by hand (keys: the prod-deploy skill, section Env file)"
else
  mode="$(stat -f %Lp "$ENV_FILE")"
  if [ "$mode" = 600 ]; then ok "env file mode 600"; else act "chmod 600 $ENV_FILE (was $mode)" chmod 600 "$ENV_FILE"; fi
  missing=()
  for k in DATABASE_URL NUXT_DATABASE_URL BETTER_AUTH_SECRET NUXT_BETTER_AUTH_SECRET BETTER_AUTH_URL \
           NUXT_BETTER_AUTH_URL STORAGE_LOCAL_DIR NUXT_STORAGE_LOCAL_DIR NITRO_HOST NITRO_PORT; do
    grep -qE "^$k=." "$ENV_FILE" || missing+=("$k")
  done
  if [ ${#missing[@]} -eq 0 ]; then ok "env file has every required key"; else fail "env file lacks: ${missing[*]}"; fi
  for k in DATABASE_URL NUXT_DATABASE_URL; do
    host="$(val "$k" | sed -nE 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#p')"
    if [ "$host" = "$DB_HOST" ]; then ok "$k host $DB_HOST"; else fail "$k host is '${host:-?}', not $DB_HOST"; fi
  done
  [ "$(val NITRO_HOST)" = 0.0.0.0 ] && ok "NITRO_HOST 0.0.0.0" || fail "NITRO_HOST must be 0.0.0.0 (Pangolin reaches the mini by IP)"
  [ "$(val NITRO_PORT)" = 3000 ] && ok "NITRO_PORT 3000" || fail "NITRO_PORT must be 3000"
  for k in STORAGE_LOCAL_DIR NUXT_STORAGE_LOCAL_DIR; do
    [ "$(val "$k")" = "$ROOT/data/uploads" ] && ok "$k $ROOT/data/uploads" || fail "$k must be $ROOT/data/uploads"
  done
  # The web reads runtimeConfig only through NUXT_* at runtime (prod-deploy gotcha #1): a plain key
  # without its twin silently keeps the value baked at build in LXC 114.
  while IFS= read -r k; do
    case "$k" in DATABASE_URL|BETTER_AUTH_SECRET|BETTER_AUTH_URL|ALLOW_SIGNUP|STORAGE_*|MEMORY_AUTO_REVIEW_THRESHOLD)
      grep -qE "^NUXT_$k=" "$ENV_FILE" || fail "env file sets $k but not NUXT_$k" ;;
    esac
  done < <(grep -oE '^[A-Z_][A-Z0-9_]*' "$ENV_FILE" | grep -v '^NUXT_' | sort -u)
fi

# 6. Scripts launchd and CD run: ~/mymind/bin/{run,release}.sh, copied from this deploy dir.
for s in run.sh release.sh; do
  if cmp -s "$HERE/$s" "$ROOT/bin/$s" 2>/dev/null; then ok "bin/$s current"
  else act "install bin/$s" install -m 755 "$HERE/$s" "$ROOT/bin/$s"; fi
done

# 7. LaunchAgents: render the templates for this $HOME and lint them. NEVER reload a loaded agent here
#    (that would restart prod outside CD's gates): a changed plist of a RUNNING agent is left pending in
#    ~/mymind/deploy/agents/ and applied by `release.sh restart` (bootout → wait for exit → bootstrap),
#    inside the gated activate step. An agent that isn't loaded gets its plist installed directly (it
#    is not started here — it would start before any release exists).
uid="$(id -u)"
PENDING="$ROOT/deploy/agents"
for label in com.mymind.web com.mymind.worker; do
  rendered="$(mktemp -t "$label")"
  sed "s#__HOME__#$HOME#g" "$HERE/$label.plist" > "$rendered"
  if plutil -lint -s "$rendered"; then ok "$label.plist lints"; else fail "$label.plist does not lint"; rm -f "$rendered"; continue; fi
  dest="$AGENTS/$label.plist"
  is_loaded=0; launchctl print "gui/$uid/$label" >/dev/null 2>&1 && is_loaded=1
  if cmp -s "$rendered" "$dest"; then ok "$label.plist installed and current"
  elif [ "$CHECK" = 1 ]; then fail "$dest $( [ -f "$dest" ] && echo differs || echo 'not installed' ) (would $( [ "$is_loaded" = 1 ] && echo 'stage it for the next release.sh restart' || echo install ))"
  elif [ "$is_loaded" = 1 ]; then
    mkdir -p "$PENDING"; install -m 644 "$rendered" "$PENDING/$label.plist"
    fix "$label is running: changed plist pending in $PENDING (applied by release.sh restart)"
  else
    install -m 644 "$rendered" "$dest"; fix "installed $dest"
  fi
  # Keep the pending copy in step with the template either way, so restart's cmp sees no false change.
  if [ "$CHECK" = 0 ]; then mkdir -p "$PENDING"; install -m 644 "$rendered" "$PENDING/$label.plist"; fi
  rm -f "$rendered"
  if [ "$is_loaded" = 1 ]; then ok "$label loaded"; else warn "$label not loaded (release.sh restart bootstraps it)"; fi
done

# 8. Read-only context.
if pgrep -qf BlueBubbles; then ok "BlueBubbles running (left alone)"; else warn "BlueBubbles not running (iMessage channel) — not touched by this script"; fi
free_gb="$(df -g "$HOME" | awk 'NR==2 {print $4}')"
if [ "${free_gb:-0}" -ge 8 ]; then ok "${free_gb} GB free"; else warn "only ${free_gb} GB free (workspace work pauses under 5 GB)"; fi

if [ "$FAILS" -gt 0 ]; then echo "[provision] $FAILS problem(s)"; exit 1; fi
echo "[provision] done"
