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
DATABASE_URL=postgres://mymind:${PW}@127.0.0.1:5432/mymind
SEARCH_SEARXNG_URL=http://127.0.0.1:8088
STORAGE_LOCAL_DIR=$APP_DIR/.data/uploads
NITRO_PORT=3000
NITRO_HOST=127.0.0.1
EOF
fi

# 3. Native dirs + one-time uploads migration from the docker volume
mkdir -p "$APP_DIR/.data/uploads" "$APP_DIR/workspace"
if [ -z "$(ls -A "$APP_DIR/.data/uploads" 2>/dev/null)" ] && docker volume inspect mymind-uploads >/dev/null 2>&1; then
  echo "[provision] migrating mymind-uploads volume -> $APP_DIR/.data/uploads"
  docker run --rm -v mymind-uploads:/src -v "$APP_DIR/.data/uploads":/dst alpine \
    sh -c 'cp -a /src/. /dst/ 2>/dev/null || true'
fi

# 4. systemd unit (refresh + enable; do NOT start here — the deploy restarts after build)
install -m 644 "$APP_DIR/deploy/mymind.service" /etc/systemd/system/mymind.service
systemctl daemon-reload
systemctl enable mymind >/dev/null 2>&1 || true
echo "[provision] done"
