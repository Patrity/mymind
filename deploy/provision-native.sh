#!/usr/bin/env bash
# One-time + idempotent provisioning for the native MyMind deploy in LXC 114.
# Called by the CD deploy job (and safe to run by hand). Run from /opt/mymind as root.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # /opt/mymind
cd "$APP_DIR"

# 1. Node 22 + pnpm (skip if already present at v22)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  echo "[provision] installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true

# 2. .env.native (only if missing — never clobber a real one)
if [ ! -f "$APP_DIR/.env.native" ]; then
  echo "[provision] writing .env.native"
  PW="$(grep -E '^POSTGRES_PASSWORD=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
  cat > "$APP_DIR/.env.native" <<EOF
# Plain vars — read directly from process.env (migrate/drizzle-kit, SearXNG client, Nitro host/port).
DATABASE_URL=postgres://mymind:${PW}@127.0.0.1:5432/mymind
SEARCH_SEARXNG_URL=http://127.0.0.1:8088
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
  val="$(grep -E "^${plain}=" "$APP_DIR/.env.native" | head -1 | cut -d= -f2-)"
  if [ -n "$val" ] && ! grep -qE "^${nuxt}=" "$APP_DIR/.env.native"; then
    echo "[provision] adding ${nuxt} (runtime override for nuxt runtimeConfig)"
    echo "${nuxt}=${val}" >> "$APP_DIR/.env.native"
  fi
}
if [ -f "$APP_DIR/.env.native" ]; then
  ensure_nuxt_override DATABASE_URL NUXT_DATABASE_URL
  ensure_nuxt_override STORAGE_LOCAL_DIR NUXT_STORAGE_LOCAL_DIR
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

# 4. systemd unit (refresh + enable; do NOT start here — the deploy restarts after build)
install -m 644 "$APP_DIR/deploy/mymind.service" /etc/systemd/system/mymind.service
systemctl daemon-reload
systemctl enable mymind >/dev/null 2>&1 || true
echo "[provision] done"
