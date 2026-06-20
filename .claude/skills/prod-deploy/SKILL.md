---
name: prod-deploy
description: Use when interacting with the MyMind PRODUCTION deployment — checking app health/logs, restarting the service, inspecting/editing prod env, running DB ops against prod, diagnosing a bad deploy, or rolling back. Prod is a native systemd app in Proxmox LXC 114, reached via SSH to the Proxmox host. Covers the access pattern, common ops, and the runtimeConfig/bind gotchas that have caused incidents.
---

# Prod deployment ops (LXC 114)

The MyMind production app runs **natively** (not Docker) as a `systemd` service inside an
**unprivileged Proxmox LXC, CTID 114**, on the Proxmox host. Postgres (pgvector) and SearXNG
stay Docker containers inside that same LXC. Full reference: `docs/DEPLOYMENT.md` §17–18.

## Access — always via the Proxmox host

You have SSH access. There is **no direct SSH into LXC 114**; you go through the host with `pct exec`.

```bash
# Proxmox host
ssh root@192.168.2.50 -- '<host command>'

# Anything INSIDE LXC 114 (the app)
ssh root@192.168.2.50 -- pct exec 114 -- bash -lc '<command run in the LXC>'
```

Wrap multi-line LXC scripts in single quotes; mind the nested quoting (`'"'"'` to embed a single
quote). Run read-only checks freely. For anything that restarts the service or edits env/DB,
prefer to say what you're about to do first — a restart is a few seconds of downtime.

## Topology

| Thing | Where |
|---|---|
| App | native systemd unit `mymind`, runs `node /opt/mymind/.output/server/index.mjs` as **root**, cwd `/opt/mymind`, listens `0.0.0.0:3000` |
| Code / build | `/opt/mymind` (tracked tree), build output `/opt/mymind/.output` |
| Base env | `/opt/mymind/.env` (shared; has Docker-era values like `DATABASE_URL=…@db:5432`) |
| Native overrides | `/opt/mymind/.env.native` (gitignored, **preserved across deploys**, loaded AFTER `.env`) |
| Postgres | Docker container `mymind-db`, published `127.0.0.1:5432`, db/user `mymind` |
| SearXNG | Docker container `mymind-searxng`, `127.0.0.1:8088` |
| Uploads | native dir `/opt/mymind/.data/uploads` |
| Public URL | `https://brain.costanzoclan.com` (Pangolin reverse proxy → LXC IP `:3000`) |
| CD | GitHub Actions `deploy.yml`, self-hosted runner on the Proxmox host, drives `pct exec 114` |

## Common ops

```bash
H='ssh root@192.168.2.50 -- pct exec 114 -- bash -lc'

# App status / logs
$H 'systemctl status mymind --no-pager'
$H 'journalctl -u mymind -n 120 --no-pager'
$H 'journalctl -u mymind -f'                      # live tail
$H 'journalctl -u mymind --since "10 min ago" --no-pager | grep -iE "error|unhandled|ECONNREFUSED"'

# Restart (a few seconds of downtime)
$H 'systemctl restart mymind && sleep 4 && systemctl is-active mymind'

# Health — /api/health does `select 1` (proves DB). /login is SSR-only and does NOT prove DB.
$H 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health'   # expect 200

# Containers (should be ONLY mymind-db + mymind-searxng)
$H 'docker ps'

# Inspect env WITHOUT leaking secrets (mask user:pass)
$H 'sed -E "s#://[^@]*@#://***@#" /opt/mymind/.env.native'

# What env the RUNNING process actually has (the source of truth)
$H 'pid=$(systemctl show -p MainPID --value mymind); tr "\0" "\n" < /proc/$pid/environ | grep -E "^(NUXT_DATABASE_URL|DATABASE_URL|NITRO_HOST|NODE_ENV)=" | sed -E "s#://[^@]*@#://***@#"'

# Postgres (no host port exposed beyond loopback; go via the container)
$H 'docker exec -i mymind-db psql -U mymind -d mymind -c "select count(*) from documents;"'
```

## Deploy & rollback

- **Deploy = push to `master`.** CD: sync tree → `docker compose up -d db searxng` (old app keeps
  serving) → `provision-native.sh` → `pnpm install --frozen-lockfile` + build (`--max-old-space-size=4096`)
  → `pnpm db:migrate` (sources `.env.native`) → cut over (`systemctl restart mymind`) → `/api/health`.
  **Build-before-cutover**: a failed build is a no-op, not an outage.
- Watch a run: `gh run watch <id> --exit-status` — **never pipe to `tail`** (the pipe returns
  tail's exit 0 and masks a failed deploy).
- **Provisioning** is idempotent: `$H 'cd /opt/mymind && bash deploy/provision-native.sh'` re-writes
  the unit, self-heals `.env.native` (NITRO_HOST, NUXT_* overrides), re-enables the service.
- **Rollback**: the pre-B3.1 Docker app path still exists — restore the old `docker-compose.prod.yml`
  (with the `app` service) + `docker compose up -d --build app`, then `systemctl stop mymind`.

## Gotchas that have bitten us (read before debugging a 5xx)

1. **`NUXT_DATABASE_URL`, not just `DATABASE_URL`.** `useDb()` reads `useRuntimeConfig().databaseUrl`,
   which Nuxt **bakes at build time** from the build-time `.env` (= `@db:5432`). At runtime, a plain
   `DATABASE_URL` does **not** override a `runtimeConfig` key — only the `NUXT_`-prefixed var does. The
   same applies to any `runtimeConfig` key (e.g. `storageLocalDir` → `NUXT_STORAGE_LOCAL_DIR`). If these
   are missing, the app dials the baked `@db` (which resolves via DNS search to a **public IP** →
   `ECONNREFUSED`). `migrate` still works (drizzle reads `process.env.DATABASE_URL` directly), so a
   green deploy can hide a totally broken app.
2. **Symptom of the DB gotcha:** `/login` → 200 (SSR, no DB) but every **authenticated** call
   (`/api/mcp`, `/api/hooks/cc/*`) → 500. `server/middleware/auth.ts` queries `api_tokens` first, so
   the failure surfaces only on authed requests. **Always health-check a DB-touching endpoint.**
3. **`NITRO_HOST=0.0.0.0`, not `127.0.0.1`.** Pangolin reaches the app by the LXC's IP; a loopback
   bind 502s externally while the in-LXC `localhost` health-check still passes.
4. **The mymind MCP (`mcp__mymind__*`) and the Claude Code hooks point at PROD.** When prod is down,
   your own task/memory tools and `*/hooks/cc/*` calls fail too — a useful canary, and a reason to fix
   prod before relying on those tools.
5. **`.env.native` is preserved across deploys** (CD sync excludes it). To change a runtime value you
   must edit the live file + restart; a code change to the template alone won't touch an existing box
   (that's why `provision-native.sh` has self-heal blocks).

## Don't

- Don't dump unmasked `.env`/`.env.native` or `DATABASE_URL` into the conversation — always mask creds.
- Don't restart/migrate casually during active use without flagging it.
- Don't assume `/login` 200 means healthy — use `/api/health`.
