# Native LXC Deploy (B3.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this cycle — it ends in a live prod cutover that can't be run by a subagent) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-platform the MyMind app from a Docker container to a native `systemd` service in LXC 114 (run as root), keeping `db` + `searxng` as Docker containers, so the agent's `exec` runs natively in the LXC (the prerequisite for B3.2).

**Architecture:** Add a `systemd` unit running `node .output/server/index.mjs`; reduce `docker-compose.prod.yml` to `db` + `searxng` (publish Postgres to `127.0.0.1:5432`); an idempotent `provision-native.sh` (Node/pnpm, `.env.native`, uploads migration, unit install) called by the rewritten CD `deploy` job (build → migrate → `systemctl restart` → health-check). Postgres volume never touched.

**Tech Stack:** Proxmox LXC 114 · systemd · Node 22 + pnpm · Nitro node-server output · GitHub Actions self-hosted runner (`pct exec 114`) · Docker (db + searxng only).

## Global Constraints

- This is an **infra/ops cycle — no app code changes, so no new unit tests.** Correctness is proven by `pnpm typecheck`/`test`/`build` staying green (config-only) **plus the live CD deploy + health-check** (Task 6). Lint is not a gate.
- **Run as `root`** in the unprivileged LXC (`User=root` in the unit).
- **`db` + `searxng` stay Docker.** Publish Postgres to **`127.0.0.1:5432`**. **Never touch the `mymind-pgdata` volume.**
- Native env overrides live in **`/opt/mymind/.env.native`** (gitignored, on-box, in the deploy preserve-list), loaded by the unit AFTER `.env` (so it wins), with exact values: `DATABASE_URL=postgres://mymind:<pw>@127.0.0.1:5432/mymind`, `SEARCH_SEARXNG_URL=http://127.0.0.1:8088`, `STORAGE_LOCAL_DIR=/opt/mymind/.data/uploads`, `NITRO_PORT=3000`, `NITRO_HOST=127.0.0.1`.
- Migrations read `process.env.DATABASE_URL` (drizzle-kit does NOT auto-load `.env`) → the CD migrate step **sources `.env.native`** first.
- Cutover frees `:3000` from the old app container via `docker compose up -d --remove-orphans` (app removed from the compose file).
- `provision-native.sh` is **idempotent** (safe to re-run every deploy; no-ops once done).
- After this cycle `exec` returns **`disabled`** (fail-closed) until B3.2; the gate/allowlist/UI stay.

---

## File Structure
- **Create** `deploy/mymind.service` — systemd unit.
- **Create** `deploy/provision-native.sh` — idempotent provisioning (Node/pnpm, `.env.native`, uploads migration, unit install+enable).
- **Modify** `docker-compose.prod.yml` — remove `app`; publish PG; keep `db` + `searxng`.
- **Modify** `.github/workflows/deploy.yml` — rewrite the `deploy` job for native.
- **Modify** `.env.example` — document the `.env.native` overrides.
- **Modify** `.gitignore` — add `.env.native`.
- **Modify** `Dockerfile` — legacy header comment (no longer in the deploy flow).
- **Modify** `docs/DEPLOYMENT.md` — native-deploy section, provisioning, rollback, validation.

---

## Task 1: systemd unit + env template + gitignore

**Files:** Create `deploy/mymind.service`; Modify `.env.example`, `.gitignore`.

- [ ] **Step 1: Create `deploy/mymind.service`**
```ini
[Unit]
Description=MyMind (Nuxt/Nitro) native app
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mymind
# .env first, then .env.native overrides (DB/searxng/storage/host) — order matters.
EnvironmentFile=/opt/mymind/.env
EnvironmentFile=/opt/mymind/.env.native
ExecStart=/usr/bin/node /opt/mymind/.output/server/index.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Add `.env.native` to `.gitignore`**
Append (near the existing `.env` ignore):
```
# Native-deploy overrides (on-box only; written by deploy/provision-native.sh)
.env.native
```

- [ ] **Step 3: Document the native overrides in `.env.example`**
Append a section at the end:
```
# --- Native LXC deploy (B3.1) ---
# When the app runs natively (systemd) instead of docker-compose, these overrides live
# in /opt/mymind/.env.native (gitignored, written by deploy/provision-native.sh), loaded
# by the unit AFTER this file so they win:
#   DATABASE_URL=postgres://mymind:<POSTGRES_PASSWORD>@127.0.0.1:5432/mymind
#   SEARCH_SEARXNG_URL=http://127.0.0.1:8088
#   STORAGE_LOCAL_DIR=/opt/mymind/.data/uploads
#   NITRO_PORT=3000
#   NITRO_HOST=127.0.0.1
```

- [ ] **Step 4: Sanity-check the unit is well-formed**
Run: `grep -E 'ExecStart=/usr/bin/node /opt/mymind/.output/server/index.mjs' deploy/mymind.service && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**
```bash
git add deploy/mymind.service .env.example .gitignore
git commit -m "feat(deploy): systemd unit + .env.native overrides for native LXC run"
```

---

## Task 2: Reduce `docker-compose.prod.yml` to db + searxng

**Files:** Modify `docker-compose.prod.yml`, `Dockerfile`.

- [ ] **Step 1: Rewrite `docker-compose.prod.yml`** (remove the `app` service; publish PG; keep `db` + `searxng`)
```yaml
# Production compose for MyMind — db + searxng only.
# The APP now runs NATIVELY via systemd (deploy/mymind.service), not as a container.
#   docker compose -f docker-compose.prod.yml up -d --remove-orphans db searxng
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: mymind-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: mymind
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: mymind
    volumes:
      - mymind-pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d
    ports:
      - "127.0.0.1:5432:5432"   # native app reaches Postgres on loopback
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mymind -d mymind"]
      interval: 10s
      timeout: 5s
      retries: 10

  searxng:
    image: searxng/searxng:latest
    container_name: mymind-searxng
    restart: unless-stopped
    environment:
      SEARXNG_SECRET: ${SEARXNG_SECRET:?set SEARXNG_SECRET in .env}
    volumes:
      - ./searxng:/etc/searxng:rw
    ports:
      - "${SEARXNG_PORT:-8088}:8080"   # native app reaches it at http://127.0.0.1:8088

volumes:
  mymind-pgdata:
```
(The `mymind-uploads` / `mymind-workspace` volumes are removed — they become native dirs, migrated in Task 3.)

- [ ] **Step 2: Mark the `Dockerfile` legacy** — add as the first line:
```dockerfile
# LEGACY: the app now runs NATIVELY via systemd in LXC 114 (see deploy/mymind.service +
# docs/DEPLOYMENT.md). This Dockerfile is no longer in the deploy flow; kept for reference/rollback.
```

- [ ] **Step 3: Validate compose syntax** (if Docker is available locally; else skip with a note)
Run: `docker compose -f docker-compose.prod.yml config -q 2>&1 | head` (requires `POSTGRES_PASSWORD`/`SEARXNG_SECRET` in env to fully validate — a parse error prints; an unset-var error is expected locally and fine)
Expected: no YAML/structure errors (unset-var interpolation warnings are acceptable).

- [ ] **Step 4: Commit**
```bash
git add docker-compose.prod.yml Dockerfile
git commit -m "feat(deploy): compose keeps only db+searxng (publish PG to loopback); app goes native"
```

---

## Task 3: `provision-native.sh` (idempotent)

**Files:** Create `deploy/provision-native.sh`.

- [ ] **Step 1: Create `deploy/provision-native.sh`**
```bash
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
```

- [ ] **Step 2: Make it executable + shellcheck**
Run: `chmod +x deploy/provision-native.sh && shellcheck deploy/provision-native.sh 2>&1 | head` (if `shellcheck` is unavailable, skip — note it)
Expected: no errors (SC2086-style warnings on the quoted vars should not appear; fix any that do).

- [ ] **Step 3: Commit**
```bash
git add deploy/provision-native.sh
git commit -m "feat(deploy): idempotent provision-native.sh (node/pnpm, .env.native, uploads migration, unit)"
```

---

## Task 4: Rewrite the CD `deploy` job

**Files:** Modify `.github/workflows/deploy.yml` (the `deploy` job only; leave `test` job unchanged).

- [ ] **Step 1: Replace the `deploy` job** with:
```yaml
  deploy:
    needs: test
    if: github.ref == 'refs/heads/master'
    runs-on: [self-hosted, proxmox]
    timeout-minutes: 25
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Sync code into LXC 114
        run: |
          # Clear the tracked tree (preserve runtime state) so deletions propagate.
          pct exec 114 -- bash -lc 'cd /opt/mymind && find . -maxdepth 1 -mindepth 1 \
            ! -name .git ! -name .env ! -name .env.native ! -name .data ! -name .output \
            ! -name .nuxt ! -name node_modules ! -name workspace -exec rm -rf {} +'
          tar -C "$GITHUB_WORKSPACE" \
            --exclude=.git --exclude=node_modules --exclude=.nuxt \
            --exclude=.output --exclude=.data --exclude=.env --exclude=.env.native \
            -cf - . | pct exec 114 -- tar -C /opt/mymind -xf -

      - name: Start db + searxng (drop the old app container)
        run: |
          pct exec 114 -- bash -lc 'cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d --remove-orphans db searxng'

      - name: Provision native runtime (idempotent)
        run: |
          pct exec 114 -- bash -lc 'cd /opt/mymind && bash deploy/provision-native.sh'

      - name: Install + build + migrate
        run: |
          pct exec 114 -- bash -lc 'cd /opt/mymind && pnpm install --frozen-lockfile && NUXT_PUBLIC_UNMUTE_URL="" pnpm build && set -a && . ./.env.native && set +a && pnpm db:migrate'

      - name: Restart native service
        run: |
          pct exec 114 -- bash -lc 'systemctl restart mymind'

      - name: Health check (/login -> 200)
        run: |
          pct exec 114 -- bash -lc 'for i in $(seq 1 30); do
            code=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3000/login || true)
            if [ "$code" = "200" ]; then echo "healthy"; exit 0; fi
            echo "waiting ($i): got $code"; sleep 5
          done; echo "never became healthy"; exit 1'
```

- [ ] **Step 2: Validate YAML**
Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: Confirm the `test` job is unchanged**
Run: `git diff --unified=0 .github/workflows/deploy.yml | grep -E '^\+' | grep -iE 'pnpm (typecheck|test|build)' || echo 'test job untouched'`
Expected: `test job untouched` (the rewrite only touched the `deploy` job).

- [ ] **Step 4: Commit**
```bash
git add .github/workflows/deploy.yml
git commit -m "feat(deploy): native CD — provision + build + migrate + systemctl restart (no app container)"
```

---

## Task 5: DEPLOYMENT.md — native deploy + provisioning + rollback

**Files:** Modify `docs/DEPLOYMENT.md`.

- [ ] **Step 1: Add a "Native deploy (B3.1)" section** to `docs/DEPLOYMENT.md` covering:
  - The model: app runs as a native `systemd` service (`mymind.service`, run as root) in LXC 114; `db` + `searxng` remain Docker containers; Postgres published on `127.0.0.1:5432`.
  - The `.env.native` overrides (exact keys from Global Constraints) and that it's on-box + gitignored.
  - First-time cutover: just merge to master — the CD's `provision-native.sh` step installs Node/pnpm, writes `.env.native`, migrates the `mymind-uploads` volume → `/opt/mymind/.data/uploads`, and installs+enables the unit (idempotent). Optionally run `bash deploy/provision-native.sh` by hand first for a deliberate first cutover.
  - Ongoing deploys: the CD `deploy` job (sync → `compose up -d --remove-orphans db searxng` → provision → install/build/migrate → `systemctl restart mymind` → health-check).
  - Logs/ops: `systemctl status mymind`, `journalctl -u mymind -f`, `docker ps` (only `mymind-db` + `mymind-searxng`).
  - **Rollback:** the previous app image is still on the box — restore by checking out the prior commit's `docker-compose.prod.yml` (with the `app` service) and `docker compose up -d --build app`, then `systemctl stop mymind`. Keep until the native deploy is confirmed stable.
  - Note: `exec` is **disabled** (fail-closed) post-B3.1 until B3.2 reworks the runner.
  Write real prose (no placeholders) — mirror the style of the existing CI/CD section.

- [ ] **Step 2: Commit**
```bash
git add docs/DEPLOYMENT.md
git commit -m "docs(deploy): native LXC deploy + provisioning + rollback runbook (B3.1)"
```

---

## Task 6: Verify gates, then the live cutover + validation

**Files:** none (verification + live ops).

- [ ] **Step 1: Gates stay green (config-only changes)**
Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck 0, full suite passing (no app-code change → same count as master's 503), build clean. (If anything fails, a config change leaked into app behavior — investigate.)

- [ ] **Step 2: Merge to master** (via finishing-a-development-branch) — this triggers the CD. **Before/at merge, confirm with Tony** that he's ready for the live cutover (brief restart blip; rollback path documented).

- [ ] **Step 3: Watch the CD deploy run**
Run: `gh run watch $(gh run list --workflow deploy --limit 1 --json databaseId --jq '.[0].databaseId')` (or `gh run list`)
Expected: the `deploy` job succeeds (provision → build → migrate → restart → health-check 200).

- [ ] **Step 4: Validate on prod** (the real test — do via the live app / the box):
  - `pct exec 114 -- systemctl status mymind` → active (running), `node .../index.mjs` as root.
  - `pct exec 114 -- docker ps` → only `mymind-db` + `mymind-searxng` (no `mymind-app`).
  - Prod login works; a search returns; an **existing uploaded image still loads** (uploads migration OK); a **new upload persists**; `web_search` works (SearXNG on 127.0.0.1:8088).
  - `pct exec 114 -- bash -lc 'systemctl restart mymind && sleep 8 && curl -fsS -o /dev/null -w "%{http_code}\n" localhost:3000/login'` → `200` (survives restart; cron `scheduledTasks` resume in-process).
- [ ] **Step 5: Record the outcome** in the cycle handover (Task in the finishing step) — gates, the deploy run id, and the prod validation results. If validation fails, roll back per DEPLOYMENT.md and report.

---

## Self-Review

**Spec coverage:**
- systemd unit (run as root) → Task 1. ✅
- `.env.native` overrides (exact values) → Task 1 + the provision script (Task 3) writes them. ✅
- compose reduced to db+searxng + PG published to 127.0.0.1:5432 → Task 2. ✅
- CD rewrite (compose up --remove-orphans → provision → build/migrate → systemctl restart → health) → Task 4. ✅
- uploads migration (volume → native dir), Postgres untouched → Task 3 (provision script) + Task 6 validation. ✅
- Dockerfile retired (legacy note) → Task 2. ✅
- DEPLOYMENT.md + rollback → Task 5. ✅
- exec fail-closed interim → noted in Global Constraints + DEPLOYMENT (Task 5). ✅
- Validation = gates + live deploy → Task 6. ✅

**Placeholder scan:** Task 5 is a doc-writing task described by content requirements (not literal prose) — acceptable for a docs task, but it lists the exact required content; no TBD/TODO elsewhere. All scripts/configs are complete. ✅

**Consistency:** `.env.native` keys identical across the unit (Task 1), provision script (Task 3), and `.env.example` (Task 1); the migrate step sources `.env.native` (Task 4) matching drizzle-kit's `process.env.DATABASE_URL` need; `--remove-orphans` cutover consistent between Task 2 (app removed from file) and Task 4 (the up command); preserve-list includes `.env.native` + `workspace` (Task 4) matching the native dirs (Task 3). ✅
