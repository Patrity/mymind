---
title: Native LXC Deploy (Cycle B3.1) — app off Docker → systemd
cycle: 34 (B3.1)
date: 2026-06-19
status: spec
task: d1d7f0ab (Cycle B)
follows: 2026-06-18-exec-approval-gate.md (B2)
enables: B3.2 (credentialed, self-installing native exec environment)
related:
  - ../../DEPLOYMENT.md
  - ../../wiki/agent-exec.md
---

# Native LXC Deploy (Cycle B3.1)

## Goal
Re-platform the MyMind **app** from a Docker container to a **native `systemd` service inside
LXC 114**, so the agent's `exec` runs directly in the LXC — the prerequisite for B3.2 (a
credentialed, self-installing environment the agent manages). This cycle ships **no
user-visible feature**; it changes how the app runs and deploys. The B2 approval gate /
allowlist / UI are untouched.

## Why
The user wants the agent to operate "outside Docker — the LXC is already the container; Docker
was only for deploy convenience." Today the app is a Docker container nested in LXC 114, so
`exec` can only run inside that container (the B2 `setpriv`/jail/stripped-env model). Running
the app natively makes the **LXC itself** the agent's environment: real filesystem, network,
package installs, and persistence — with the unprivileged LXC as the isolation boundary (the
user's accepted posture; cf. openclaw/hermes).

## Current state (what we're changing)
`docker-compose.prod.yml` in LXC 114 runs **three** containers; the CD `deploy` job runs on a
Proxmox-host self-hosted runner and drives the LXC via `pct exec 114`:
- `db` — `pgvector/pgvector:pg16`, the entire corpus on the `mymind-pgdata` volume, **no host
  port** (app reaches it on the compose network as `db:5432`).
- `app` — the Nitro app (built from `Dockerfile`), `env_file .env`, volumes `mymind-uploads`
  (`/app/.data/uploads`) + `mymind-workspace` (`/workspace`), port 3000.
- `searxng` — `searxng/searxng`, LAN-published on `${SEARXNG_PORT:-8088}`, app reaches it as
  `searxng:8080`.

## Decisions (user-approved 2026-06-19)
1. **App + exec go native; `db` + `searxng` stay Docker containers** in LXC 114. Postgres is
   published to `127.0.0.1:5432` for the native app. **Zero corpus migration** — the
   `mymind-pgdata` volume is never touched.
2. **Run as `root` in the unprivileged LXC.** The native app (and therefore `exec`) runs as
   root within LXC 114 so the agent can install anything / manage the box. The LXC is
   unprivileged, so root-in-LXC stays contained to the LXC (not the Proxmox host).
3. **No host-escape hacks** — the app genuinely runs native; we do not bridge from a container
   to the host.

## Architecture

### 1. systemd unit — `deploy/mymind.service`
Runs the built Nitro node-server output directly:
```ini
[Unit]
Description=MyMind (Nuxt/Nitro)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mymind
EnvironmentFile=/opt/mymind/.env
EnvironmentFile=/opt/mymind/.env.native      # native overrides (DB/searxng/storage/host/port)
ExecStart=/usr/bin/node /opt/mymind/.output/server/index.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```
`.env.native` (written once during provisioning, gitignored) holds the values compose used to
inject:
```
DATABASE_URL=postgres://mymind:<POSTGRES_PASSWORD>@127.0.0.1:5432/mymind
SEARCH_SEARXNG_URL=http://127.0.0.1:8088
STORAGE_LOCAL_DIR=/opt/mymind/.data/uploads
NITRO_PORT=3000
NITRO_HOST=127.0.0.1
```
(Verify `nuxt.config` uses the default Nitro **node-server** preset so `.output/server/index.mjs`
exists. Bind `127.0.0.1` — the TLS reverse proxy already fronts it.)

### 2. `docker-compose.prod.yml` — keep only `db` + `searxng`
Remove the `app` service (and its build/volumes/ports). **Publish Postgres** to the host:
`ports: ["127.0.0.1:5432:5432"]` on `db`. `searxng` is unchanged (already publishes 8088).
Volumes section keeps `mymind-pgdata` (+ `searxng` config mount); `mymind-uploads` /
`mymind-workspace` volumes are no longer compose-managed (migrated to native dirs, below).

### 3. CD rewrite — `.github/workflows/deploy.yml` (deploy job)
```
sync source into /opt/mymind (unchanged tar approach; also preserve .env.native + .data)
→ docker compose -f docker-compose.prod.yml up -d --remove-orphans db searxng   # --remove-orphans drops the now-removed app container (clean cutover, frees :3000)
→ wait for db healthy
→ pnpm install --frozen-lockfile
→ pnpm build                      # produces .output (NUXT_PUBLIC_UNMUTE_URL="")
→ pnpm db:migrate
→ systemctl restart mymind
→ health-check http://localhost:3000/login → 200 (retry loop, as today)
```
The `test` job (lint/typecheck/test/build on ubuntu) is unchanged. The deploy preserve-list
in the sync step adds `.env.native`.

### 4. LXC 114 one-time provisioning (documented in DEPLOYMENT.md, done by hand once)
- Install Node 22 + pnpm (corepack) in the LXC.
- Write `/opt/mymind/.env.native`.
- Install `deploy/mymind.service` → `systemctl enable mymind`.
- **Migrate uploads:** copy the `mymind-uploads` docker volume contents →
  `/opt/mymind/.data/uploads` (e.g. `docker run --rm -v mymind-uploads:/src -v
  /opt/mymind/.data/uploads:/dst alpine cp -a /src/. /dst/`). Create
  `/opt/mymind/workspace` (the agent home, used in B3.2). **Postgres volume untouched.**

### 5. Cleanup
- The app `Dockerfile` is **retired** (build is native now). Keep it out of the compose flow;
  remove or mark obsolete. The B2 Dockerfile additions (`agent` uid 10001, `util-linux`/`setpriv`,
  `EXEC_AGENT_*`) are no longer used — exec's native model is reworked in **B3.2**.
- The `mymind-workspace` Docker volume + `/workspace` jail are superseded by a native dir in B3.2.

### 6. Exec in the interim (B3.1 → B3.2)
After B3.1, the app runs as root natively but `EXEC_AGENT_UID` is gone (Dockerfile retired), so
the B2 runner's `selectExecMode` finds no `setuid` path and (in production, with the dev
`EXEC_UNCONFINED` hatch hard-disabled) returns **`disabled` — exec fails closed.** The approval
gate, allowlist, settings tab, and approval UI all remain intact; exec simply returns "disabled"
until **B3.2** reworks `runConstrained` for the native root-in-LXC model. This is a safe interim
(exec was opt-in + never prod-validated anyway).

## Scope
**In:** systemd unit, `docker-compose.prod.yml` reduction (+ publish PG), `deploy.yml` rewrite,
`.env.native`, uploads migration, DEPLOYMENT.md update, Dockerfile retirement, the documented
LXC provisioning runbook.
**Out (B3.2 and later):** the native `runConstrained` rework; the encrypted secrets store +
credential injection; persistent self-install / preinstalled CLIs; artifact rendering; B4
(other homelab hosts).

## Validation
This is an infra cycle — correctness is proven by the **live deploy**, not unit tests:
- The CD `deploy` job succeeds (db+searxng up, build, migrate, `systemctl restart`, health-check 200).
- Post-deploy on prod: login works; a search returns; an existing uploaded image still loads
  (uploads migration succeeded); a new upload persists; the app survives an LXC reboot (systemd
  `enable`). `web_search` still reaches SearXNG on `127.0.0.1:8088`.
- `systemctl status mymind` shows the native process as root; `docker ps` shows only `db` +
  `searxng` (no `app` container).
- `pnpm typecheck` / `pnpm test` stay green (the app code is largely unchanged; only
  config/compose/CD/docs move).

## Risks & mitigations
- **Live, internet-exposed prod re-platform.** Mitigation: the CD health-check gates success;
  keep the previous compose `app` image available for a one-command rollback (`docker compose up
  -d app` with the old compose file) until the native deploy is confirmed stable. A brief restart
  blip during cutover is acceptable (single-user).
- **Uploads data migration.** Mitigation: copy (not move) the volume; verify an existing image
  loads before removing the old volume. Postgres is never migrated.
- **First-cutover port/orphan conflict** (the old `app` container holds `:3000`). Mitigation:
  `docker compose up -d --remove-orphans` removes the now-unlisted `app` container, freeing the
  port before `systemctl restart mymind`.
- **`.env.native` drift / secrets.** It's gitignored, on the box only, in the deploy
  preserve-list; documented in DEPLOYMENT.md.

## Open questions
None blocking. The one-time LXC provisioning is a documented manual runbook (Node/pnpm install,
`.env.native`, unit install, uploads copy) run once before the first native CD deploy.
