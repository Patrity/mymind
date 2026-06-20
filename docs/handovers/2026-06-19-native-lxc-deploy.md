---
title: Native LXC Deploy (Cycle B3.1) — app off Docker → systemd
cycle: 34 (B3.1)
date: 2026-06-19
status: shipped
branch: worktree-b3-native-deploy (merged to master 2ff6fc0)
task: d1d7f0ab (Cycle B)
spec: ../superpowers/specs/2026-06-19-native-lxc-deploy-b3-1-design.md
plans:
  - ../superpowers/plans/2026-06-19-native-lxc-deploy-b3-1.md
docs:
  - ../DEPLOYMENT.md (§18 Native deploy)
enables: B3.2 (credentialed, self-installing native exec environment)
shipped:
  - "**systemd unit** (`deploy/mymind.service`) — runs `node /opt/mymind/.output/server/index.mjs` as **root** in LXC 114, `Restart=always`, loading `.env` then `.env.native` (overrides win)."
  - "**`docker-compose.prod.yml` reduced to db + searxng** — `app` service removed; Postgres published to `127.0.0.1:5432`; `mymind-uploads`/`mymind-workspace` volumes dropped (now native dirs). **`mymind-pgdata` (the corpus) untouched.**"
  - "**`deploy/provision-native.sh`** (idempotent) — installs Node 22 + pnpm, writes `/opt/mymind/.env.native` (DB→127.0.0.1:5432, searxng→127.0.0.1:8088, STORAGE_LOCAL_DIR, NITRO host/port; PG password derived from `.env`), **migrates the `mymind-uploads` docker volume → `/opt/mymind/.data/uploads`** (one-time), installs+enables the unit."
  - "**Native CD** (`.github/workflows/deploy.yml`) — sync → `compose up -d db searxng` (old app keeps serving) → provision → install+build+migrate (`--max-old-space-size=4096`; migrate sources `.env.native`) → **cut over** (`--remove-orphans` drops the old app + `systemctl restart mymind`) → `/login` health-check. **Build-before-cutover** = a slow/failed build never causes an outage."
  - "**Dockerfile retired** (legacy header; no longer in the deploy flow). `.env.native` doc'd in `.env.example`; already gitignored via `.env.*`. DEPLOYMENT.md §18 (native deploy + provisioning + rollback)."
validation:
  - "**Gates** (in-worktree, config-only): typecheck 0 / test 503 / build — unchanged from master (no app-code change)."
  - "**Live deploy: GREEN** (run 27856834029, master 2ff6fc0). All deploy steps success: provision → build+migrate → **cut over** (`mymind-app` container Stopped→Removed; `mymind-db`+`mymind-searxng` still Running) → **health-check `healthy` (login 200)**. The app now runs natively (systemd) in LXC 114."
  - "**First attempt failed SAFE** (run 27856684336): the native server build OOM'd at V8's ~2GB default heap (`FATAL ERROR: … JavaScript heap out of memory`). Because the CD builds BEFORE cutover, the cutover + health-check steps were skipped and **the old docker app kept serving — no outage.** Fixed by `NODE_OPTIONS=--max-old-space-size=4096` on the build step."
  - "**Post-cutover incident RESOLVED** (2026-06-20, masters `4a321df` + `9c2fdbf`): external 500s on all authenticated APIs — (1) loopback `NITRO_HOST` → 502, fixed to `0.0.0.0`; (2) missing `NUXT_DATABASE_URL` → app dialed the build-baked `@db` → `ECONNREFUSED`, fixed via `NUXT_*` runtimeConfig overrides + `NODE_ENV=production`. Diagnosed + hot-fixed live via `ssh root@192.168.2.50 → pct exec 114`; verified `/api/health`→`{ok:true}` 200 external, MCP+hooks recovered, zero `ECONNREFUSED` since. Re-deploy (run 27857757521) **green** through the new DB-touching `/api/health` gate."
  - "**Uploads migration BUG found + fixed** (2026-06-20): provision checked the bare volume `mymind-uploads` but the docker app's real volume is the compose-prefixed `mymind_mymind-uploads`, so the blobs (22 files / 14M) were never copied and the native uploads dir was empty (existing images would not load). Manually copied `mymind_mymind-uploads` → `/opt/mymind/.data/uploads`; verified all sampled `images.storage_key` resolve in the sharded layout. provision-native.sh now auto-detects any `*mymind-uploads` volume with content."
  - "**Still pending (Tony, optional):** a **new upload persists** + the service **survives an LXC reboot**. App health, DB connectivity, uploads (existing blobs migrated + resolve), `systemctl active`/`enabled`, and `docker ps` (only db+searxng) confirmed via SSH."
deferred:
  - "**B3.2** — the native `runConstrained` rework (drop the docker setpriv-to-uid-10001 model; run as root-in-LXC) + the encrypted secrets store + credential injection (GitHub/CF/Neon/Railway tokens) + persistent self-install. Until then `exec` returns `disabled` (fail-closed); the gate/allowlist/UI remain."
  - "**LXC RAM headroom**: the native build needs >2GB heap (now 4GB). If a future build trips a *kernel* OOM (vs the V8 one), bump LXC 114's RAM in Proxmox. Consider building on the CD runner + shipping `.output` if in-LXC build memory becomes a recurring issue (migrate still needs node+drizzle-kit in the LXC)."
  - "**Mirror docs to MyMind** (per the CLAUDE.md rule) — DEPLOYMENT.md §18 + this handover not yet mirrored."
---

# Native LXC Deploy (Cycle B3.1)

The first step of the "agent operates outside Docker" program (task `d1d7f0ab`): the MyMind app
now runs as a **native `systemd` service in LXC 114** (as root), not a Docker container. `db`
(pgvector) and `searxng` stay containers (Postgres on `127.0.0.1:5432`); the corpus volume was
never migrated. This makes the LXC itself the agent's environment — the prerequisite for **B3.2**
(credentialed, self-installing `exec`). Full reference: [DEPLOYMENT.md §18](../DEPLOYMENT.md).

## How it shipped
Brainstorm → spec → plan → **inline** execution (executing-plans), isolated worktree
`b3-native-deploy`. User-approved decisions: app+exec native, db+searxng stay docker (zero corpus
migration), run as root in the unprivileged LXC. Five config tasks (unit, compose, provision
script, native CD, DEPLOYMENT.md), gates green, then the live cutover — merged to master, CD
deployed.

## The cutover (what actually happened)
1. **First deploy failed safe.** The native `nuxt build` OOM'd at V8's default ~2GB heap. The
   build-before-cutover ordering meant the old docker app never stopped → **no outage**.
2. **Heap fix.** `NODE_OPTIONS=--max-old-space-size=4096` on the build step. Re-deploy **green**:
   build → migrate → cut over (old `mymind-app` removed) → `systemctl restart mymind` →
   health-check 200. Native app live.

## Post-cutover incident (same night) — external 500s on all authenticated APIs
The cutover passed its `/login` health check but **every authenticated request** (`/api/mcp`, the
Claude Code `/api/hooks/cc/*` hooks) returned 5xx externally. Two independent root causes, both
fixed and verified on the box (`ssh root@192.168.2.50 → pct exec 114`), then made permanent in code:

1. **`NITRO_HOST=127.0.0.1` (loopback) → 502** (master `4a321df`). Pangolin reaches the app by the
   LXC's IP, so a loopback bind is unreachable externally. The CD's *in-LXC* `localhost:3000` check
   passed and masked it. Fix: bind `0.0.0.0` (parity with the old docker publish); provision
   self-heals an existing loopback `.env.native`.
2. **Missing `NUXT_DATABASE_URL` → 500 (`ECONNREFUSED`)** (master `9c2fdbf`) — the real one.
   `useDb()` reads `useRuntimeConfig().databaseUrl`, which Nuxt **bakes at build** from the
   build-time `.env` (`@db:5432`). A plain `DATABASE_URL` does **not** override a `runtimeConfig`
   key at runtime — only `NUXT_DATABASE_URL` does. So the app kept dialing the baked `@db` (DNS
   search → public IP `192.99.62.192` → refused), while `migrate` worked (drizzle reads
   `process.env.DATABASE_URL` directly). `/login` (SSR, no DB) masked it; `auth.ts` queries
   `api_tokens` first, so only authed calls 500'd. Fix: write/self-heal `NUXT_DATABASE_URL` +
   `NUXT_STORAGE_LOCAL_DIR` in `.env.native` + `NODE_ENV=production` parity in the unit.
3. **Hardening:** new DB-touching `/api/health` (`select 1`, public); the CD gate now hits it
   instead of `/login` so this class of silent DB failure can't pass again. Added the
   **`prod-deploy` skill** (`.claude/skills/prod-deploy/`) documenting the access pattern + gotchas.

Confirmed after the fix: `/api/health` → `{ok:true}` 200 externally, MCP + hooks recovered, zero
`ECONNREFUSED` since the restart.

## Lessons
- **Nuxt `runtimeConfig` is baked at build, not read from runtime env.** Plain env vars don't
  override a `runtimeConfig` key at runtime — only `NUXT_`-prefixed ones do. A native deploy that
  only sets `DATABASE_URL` (not `NUXT_DATABASE_URL`) silently runs against the *build-baked* DB.
- **`/login` is not a health check.** It's SSR with no DB hit, so it returns 200 over a dead DB.
  Health-check a DB-touching, authed-class path (now `/api/health` → `select 1`).
- **SSH the box before theorizing.** One `journalctl -u mymind` showed `ECONNREFUSED` to the baked
  host instantly; static code analysis sent me down wrong paths (env parity, Node version) first.
- `gh run watch --exit-status | tail` **masks gh's exit code** (the pipe returns tail's 0) — the
  first run reported "success" while actually failing. Don't pipe when relying on exit status.
- A native Nuxt build needs a raised Node heap that the docker multi-stage build didn't expose.
- Building before cutover is the right ordering for a live box: a build failure is a no-op, not an outage.

## Next
**B3.2** turns `exec` back on natively + adds the credentialed, self-installing environment (the
actual payoff of the user's vision). The harness (gate/allowlist/UI from B2) is unchanged; only
`runConstrained` + the env/secrets/install layer change.
