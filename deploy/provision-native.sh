#!/usr/bin/env bash
# One-time + idempotent provisioning of LXC 114. Called by the CD deploy job (and safe to run by hand).
# Run from /opt/mymind as root.
#
#   provision-native.sh               target lxc: LXC 114 BUILDS and RUNS MyMind (web + worker systemd
#                                     units, the Docker Postgres) — the pre-cutover runtime
#   provision-native.sh --build-only  target macmini (cycle 86): LXC 114 only builds the releases CD ships
#                                     to the Mac mini and runs the migrations against 192.168.2.80 — Node +
#                                     pnpm and a check of .env.macmini; no units, no runtime env
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # /opt/mymind
cd "$APP_DIR"
BUILD_ONLY=0
case "${1:-}" in --build-only) BUILD_ONLY=1 ;; '') ;; *) echo "usage: $0 [--build-only]" >&2; exit 2 ;; esac

# 1. Node 22 + pnpm (skip if already present at v22)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  echo "[provision] installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true

if [ "$BUILD_ONLY" = 1 ]; then
  # .env.macmini: what CD exports before `pnpm eval --cancel-all` + `pnpm db:migrate` against the central
  # DB. Written once by hand at cutover (0600); checked here by key name and DB host, never printed.
  # BOTH keys: core prefers NUXT_DATABASE_URL, and the eval CLI fills unset keys from .env (the old DB).
  f="$APP_DIR/.env.macmini"
  [ -f "$f" ] || { echo "[provision] $f missing — write DATABASE_URL + NUXT_DATABASE_URL for 192.168.2.80 (0600)" >&2; exit 1; }
  chmod 600 "$f"
  for k in DATABASE_URL NUXT_DATABASE_URL; do
    host="$(grep -E "^$k=" "$f" | tail -1 | cut -d= -f2- | sed -nE 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#p' || true)"
    [ "$host" = 192.168.2.80 ] || { echo "[provision] $f: $k must point at 192.168.2.80 (host is '${host:-unset}')" >&2; exit 1; }
  done
  # After cutover the app runs on the mini only: a still-running LXC worker would execute Tony's jobs a
  # second time against the old database. Stopping it is the cutover runbook's step, not this script's.
  for u in mymind mymind-worker; do
    if systemctl is-active --quiet "$u" 2>/dev/null; then
      echo "::warning title=LXC 114 runtime still active::$u is running in LXC 114 while prod deploys to the Mac mini — systemctl disable --now $u"
    fi
  done
  echo "[provision] build box ready"
  exit 0
fi

# 2. .env.native (only if missing — never clobber a real one)
if [ ! -f "$APP_DIR/.env.native" ]; then
  echo "[provision] writing .env.native"
  PW="$(grep -E '^POSTGRES_PASSWORD=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
  cat > "$APP_DIR/.env.native" <<EOF
# Plain vars — read directly from process.env (migrate/drizzle-kit, Nitro host/port).
DATABASE_URL=postgres://mymind:${PW}@127.0.0.1:5432/mymind
STORAGE_LOCAL_DIR=$APP_DIR/.data/uploads
NITRO_PORT=3000
NITRO_HOST=0.0.0.0
# NUXT_-prefixed runtime overrides for nuxt.config runtimeConfig keys (databaseUrl, storageLocalDir).
# The APP reads useRuntimeConfig(), which is BAKED AT BUILD from the build-time .env (=> @db). At
# runtime only NUXT_* env vars override it — a plain DATABASE_URL does NOT. Without these the app
# dials the build-baked DB host (e.g. @db -> a public IP via DNS search) and every authed API 500s.
NUXT_DATABASE_URL=postgres://mymind:${PW}@127.0.0.1:5432/mymind
NUXT_STORAGE_LOCAL_DIR=$APP_DIR/.data/uploads
EOF
fi

# 2b. Self-heal: the native app must bind 0.0.0.0 so the reverse proxy can reach it via the
# LXC IP. A loopback (127.0.0.1) bind passes the in-LXC localhost health-check but 502s
# externally — correct any existing .env.native that still has the loopback bind.
if [ -f "$APP_DIR/.env.native" ] && grep -qE '^NITRO_HOST=127\.0\.0\.1' "$APP_DIR/.env.native"; then
  echo "[provision] fixing NITRO_HOST 127.0.0.1 -> 0.0.0.0"
  sed -i 's/^NITRO_HOST=127\.0\.0\.1/NITRO_HOST=0.0.0.0/' "$APP_DIR/.env.native"
fi

# 2c. Self-heal: ensure the NUXT_-prefixed runtime overrides exist on an existing .env.native
# (added after the first native deploys). The app reads useRuntimeConfig() (baked at build from
# the build-time .env); only NUXT_* env vars override it at runtime — plain DATABASE_URL does not.
# Derive each from the plain var already present in .env.native.
ensure_nuxt_override() {
  local plain="$1" nuxt="$2" val
  # `|| true`: under `set -euo pipefail` a key absent from .env.native makes grep exit 1 and would
  # kill the whole script (cycle 81 deploy failure) — absent is the common case, not an error.
  val="$(grep -E "^${plain}=" "$APP_DIR/.env.native" | head -1 | cut -d= -f2- || true)"
  if [ -n "$val" ] && ! grep -qE "^${nuxt}=" "$APP_DIR/.env.native"; then
    echo "[provision] adding ${nuxt} (runtime override for nuxt runtimeConfig)"
    echo "${nuxt}=${val}" >> "$APP_DIR/.env.native"
  fi
  return 0
}
# Cycle 81: EVERY plain var core's config mapper reads (packages/core/src/config-env.ts
# coreRuntimeConfig) is paired, not just the two above. The web bakes plain vars from the BUILD env
# (.env only) and sees .env.native values only through NUXT_*; the agent worker maps its RUNTIME env
# (.env + .env.native). Pairing makes both resolve the .env.native value. test/provision-pairs.test.ts
# fails when the mapper reads a plain key that is missing from this list.
if [ -f "$APP_DIR/.env.native" ]; then
  ensure_nuxt_override DATABASE_URL NUXT_DATABASE_URL
  ensure_nuxt_override BETTER_AUTH_SECRET NUXT_BETTER_AUTH_SECRET
  ensure_nuxt_override BETTER_AUTH_URL NUXT_BETTER_AUTH_URL
  ensure_nuxt_override ALLOW_SIGNUP NUXT_ALLOW_SIGNUP
  ensure_nuxt_override STORAGE_DRIVER NUXT_STORAGE_DRIVER
  ensure_nuxt_override STORAGE_LOCAL_DIR NUXT_STORAGE_LOCAL_DIR
  ensure_nuxt_override STORAGE_S3_ENDPOINT NUXT_STORAGE_S3_ENDPOINT
  ensure_nuxt_override STORAGE_S3_REGION NUXT_STORAGE_S3_REGION
  ensure_nuxt_override STORAGE_S3_BUCKET NUXT_STORAGE_S3_BUCKET
  ensure_nuxt_override STORAGE_S3_ACCESS_KEY_ID NUXT_STORAGE_S3_ACCESS_KEY_ID
  ensure_nuxt_override STORAGE_S3_SECRET_ACCESS_KEY NUXT_STORAGE_S3_SECRET_ACCESS_KEY
  ensure_nuxt_override MEMORY_AUTO_REVIEW_THRESHOLD NUXT_MEMORY_AUTO_REVIEW_THRESHOLD
fi

# 3. Native dirs + one-time uploads migration from the docker volume.
# The docker app stored uploads in a COMPOSE-NAMED volume: <project>_mymind-uploads (project =
# the compose dir name = "mymind" -> "mymind_mymind-uploads"), NOT the bare "mymind-uploads".
# Auto-detect any "*mymind-uploads" volume and pick the one that actually has files (avoids an
# empty stray volume). Only runs when the native dir is still empty.
mkdir -p "$APP_DIR/.data/uploads" "$APP_DIR/workspace"
if [ -z "$(ls -A "$APP_DIR/.data/uploads" 2>/dev/null)" ]; then
  best=""; best_n=0
  for vol in $(docker volume ls -q | grep -E 'mymind-uploads$' || true); do
    n="$(docker run --rm -v "$vol":/src alpine sh -c 'find /src -type f | wc -l' 2>/dev/null || echo 0)"
    if [ "${n:-0}" -gt "$best_n" ]; then best_n="$n"; best="$vol"; fi
  done
  if [ -n "$best" ] && [ "$best_n" -gt 0 ]; then
    echo "[provision] migrating uploads volume $best ($best_n files) -> $APP_DIR/.data/uploads"
    docker run --rm -v "$best":/src -v "$APP_DIR/.data/uploads":/dst alpine \
      sh -c 'cp -a /src/. /dst/ 2>/dev/null || true'
  fi
fi

# 4. systemd units (refresh + enable; do NOT start here — the deploy restarts after build)
#    mymind         — the Nuxt/Nitro web app
#    mymind-worker  — the agent worker (cycle 81): runs the active release /opt/mymind/.worker
#                     (deploy/worker-release.sh stage → activate, done by CD after the web build).
#                     Enabled here; CD (re)starts it right after `activate`, so a first provision
#                     never starts it against a missing release.
install -m 644 "$APP_DIR/deploy/mymind.service" /etc/systemd/system/mymind.service
install -m 644 "$APP_DIR/deploy/mymind-worker.service" /etc/systemd/system/mymind-worker.service
systemctl daemon-reload
systemctl enable mymind >/dev/null 2>&1 || true
systemctl enable mymind-worker >/dev/null 2>&1 || true
echo "[provision] done"
