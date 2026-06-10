# MyMind — Deployment Guide

> Audience: an agent or operator deploying MyMind to the homelab (Proxmox + Docker), internet-exposed.
> Source of truth for **how the app works** is `docs/wiki/`; this doc is **how to run it**. If anything here disagrees with the code, the code + the newest `docs/handovers/` win — update this doc.

## 0. What you're deploying

MyMind is **one Nuxt 4 service** (Nitro `node-server`) that serves:
- the **web app** (SPA for the authed UI; SSR only for public `/share/**` pages),
- **HTTP endpoints** (uploads for ShareX/CleanShot, Claude Code / Hermes hook ingestion),
- an **MCP server** at `POST /api/mcp` for agents.

It depends on:
- **PostgreSQL 16 + pgvector** (extensions: `pgcrypto`, `pg_trgm`, `ltree`, `vector`).
- A **persistent uploads volume** (content-addressed image/file blobs).
- The **local AI rig** at `192.168.2.25` (LAN) — embeddings (TEI :8882, keyless), reasoning (:8004), vision (:8005). All env-configured and optional-at-startup (the app boots without them; AI features degrade/skip).
- **In-process scheduled tasks** (embeddings, enrichment, OCR, memory extraction) that run automatically while the server is up.

**Network requirement:** the deploy host must reach BOTH the AI rig on the LAN (`192.168.2.25`) AND the public internet (for sharing / ShareX / hooks). A homelab box that sits on the LAN and is exposed via a reverse proxy is the intended shape.

## 1. Prerequisites
- Docker + Docker Compose v2 on the host.
- The repo checked out on the host (the image builds from it, and migrations run from it).
- Network reachability to `192.168.2.25` (verify: `curl -m5 http://192.168.2.25:8882/embed -X POST -H 'content-type: application/json' -d '{"inputs":"x"}'` should return a 2560-length vector).
- A TLS reverse proxy (Caddy / Traefik / nginx) for the public origin — or Cloudflare Tunnel.
- (For manual migrations / local builds only) Node 22 + `corepack enable` (pnpm 11.5 is pinned via `packageManager`).

## 2. Provided artifacts (in the repo)
- **`Dockerfile`** — multi-stage build; the runtime image runs `pnpm db:migrate` then `node .output/server/index.mjs`.
- **`docker-compose.prod.yml`** — `db` (pgvector) + `app`, with persistent volumes (`mymind-pgdata`, `mymind-uploads`).
- **`.env.example`** — every supported env var. Copy to `.env` and fill it.
- `docker-compose.yml` (dev only — db on host port 5433; do NOT use for prod).

> ⚠️ The `Dockerfile`/`docker-compose.prod.yml` were authored but have not been built in CI on the target host. **Verify the image builds** (`docker compose -f docker-compose.prod.yml build`) as your first step; `sharp` compiles a native binary during install (the build script is pre-approved in `pnpm-workspace.yaml`).

## 3. Deploy (step by step)

```bash
# 1. configure
cp .env.example .env
#    Edit .env — at minimum set (see §4):
#      POSTGRES_PASSWORD=<strong>            # used by compose for db + DATABASE_URL
#      BETTER_AUTH_SECRET=<32+ random bytes> # openssl rand -base64 48
#      BETTER_AUTH_URL=https://mymind.example.com   # your PUBLIC origin (no trailing slash)
#      AI_* endpoints (defaults already point at the rig; embeddings need no key)
#    Note: docker-compose.prod.yml OVERRIDES DATABASE_URL + STORAGE_LOCAL_DIR for the container network.

# 2. build + start (db comes up healthy, then app migrates + serves)
docker compose -f docker-compose.prod.yml up -d --build

# 3. watch logs until "Listening on http://0.0.0.0:3000" and migrations applied
docker compose -f docker-compose.prod.yml logs -f app

# 4. bootstrap the first account (see §5)
```

Extensions are created automatically on **first** DB boot via `db/init/01-extensions.sql` (only runs on a fresh `mymind-pgdata` volume). If you ever attach to an existing DB without them, apply that SQL manually.

## 4. Environment variables

| Var | Required | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | compose-only; sets the db password + is interpolated into `DATABASE_URL`. |
| `DATABASE_URL` | ✅ | set by compose to `postgres://mymind:<pw>@db:5432/mymind`. For manual migrate use the real host/port. |
| `BETTER_AUTH_SECRET` | ✅ | 32+ bytes. `openssl rand -base64 48`. |
| `BETTER_AUTH_URL` | ✅ | **public origin**, must match how users reach it (proxy origin). Mismatch → sign-in/sign-up 403 (CSRF/origin check). |
| `ALLOW_SIGNUP` | bootstrap | `true` to enable account creation; **unset after** creating your account. |
| `AI_REASONING_*` | for AI | strong model (`:8004`) — memory enrichment, transcription cleanup, `/input` proposals. |
| `AI_EMBEDDINGS_*` | for AI | TEI `:8882`, **keyless**, 2560-dim. Powers semantic search + embeddings. |
| `AI_VISION_*` | for OCR | `:8005` (8B, weak/flaky — OCR will occasionally blip, no longer loops). |
| `AI_BULK_*` | optional | bulk model role. |
| `AI_STT_* / AI_TTS_KOKORO_* / AI_TTS_CHATTERBOX_*` | for voice | the `/voice` page needs STT + at least one TTS provider (see the cycle-18 block in `.env.example`). |
| `AI_RERANK_*` | optional | Qwen3-Reranker `:8883` for memory-search relevance. OFF unless `BASE_URL` set. |
| `MEMORY_AUTO_REVIEW_THRESHOLD` | optional | default `0.75`; memories ≥ this auto-review. |
| `STORAGE_DRIVER` / `STORAGE_LOCAL_DIR` | ✅ | `local` + `/app/.data/uploads` (a mounted volume in compose). `s3` + `STORAGE_S3_*` to use S3. |
| `MAX_UPLOAD_BYTES` | optional | default 50 MB. |
| `NITRO_PORT` / `NITRO_HOST` | optional | default `3000` / `0.0.0.0`. |

> **How `AI_*` env actually reaches the app:** these are `runtimeConfig` values. They're baked at *image build* time — and bake **empty** in Docker because `.dockerignore` excludes `.env` — and at runtime Nitro only applies overrides from **`NUXT_`/`NITRO_`-prefixed** env vars; plain `AI_*` names in `env_file` do nothing by themselves. `docker-compose.prod.yml` therefore maps every plain `AI_*` name onto its `NUXT_AI_*` key, keeping the plain names in `.env` as the single source of truth. If an AI feature reports "not configured" despite a correct `.env`, check that the compose mapping covers the var.

## 5. Bootstrap the account + machine tokens

Sign-up is disabled by default (single-user, internet-exposed). To create the first account:
1. Set `ALLOW_SIGNUP=true` in `.env`, `docker compose -f docker-compose.prod.yml up -d app` (recreate).
2. Visit `https://<origin>/login` → "Create account" → register. You're signed in.
3. Set `ALLOW_SIGNUP=` (empty) and recreate the app container. (UI toggle hides AND the API rejects sign-up when off.)

**API tokens** (for ShareX, Claude Code/Hermes hooks, MCP) have no UI yet — mint one and insert it:
```bash
# generate a token + its sha256 hash
TOKEN="mm_$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
echo "TOKEN (give to the client, store securely): $TOKEN"
docker compose -f docker-compose.prod.yml exec db \
  psql -U mymind -d mymind -c "insert into api_tokens (name, token_hash) values ('sharex', '$HASH');"
```
Clients send `Authorization: Bearer $TOKEN`. Revoke by setting `revoked_at` on the row.

## 6. Reverse proxy / TLS

Point your proxy at the app container (`127.0.0.1:3000` recommended bind). Set `BETTER_AUTH_URL` to the proxy's public https origin. Example Caddyfile:
```
mymind.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
**Public (unauthenticated) routes** — everything else requires a session or bearer token:
- `GET /share/**` (SSR public document pages) and `GET /api/share/**`
- `GET /api/i/**` (public image blobs, `is_public` only)
- `GET/POST /api/auth/**` (better-auth)
Rate-limit `/api/auth`, `/api/upload`, and `/api/hooks` at the proxy.

## 7. Background scheduled tasks

These run **in-process** while the app is up (Nitro `scheduledTasks`):
| Cron | Task | Does |
|---|---|---|
| `*/5` | `embed-documents` | embeds new/changed docs (fills `documents.embedding`) |
| `*/7` | `ocr-images` | OCR + recommended tags for new images (bounded retries) |
| `*/10` | `enrich-input` | proposes frontmatter for `/input` docs → review queue |
| `*/15` | `enrich-memories` | extracts memories from new session messages |

**Run a single app instance.** These tasks aren't distributed-locked; multiple replicas would double-run them. Single-user, single instance is the design. (Manual triggers exist too: `POST /api/admin/{embed-run,ocr-run,enrich-run,memory-enrich-run}` with auth.)

## 8. Migrations
- The app container runs `pnpm db:migrate` on every start (idempotent — applies only pending migrations).
- To migrate manually (e.g. before a zero-downtime swap): `DATABASE_URL=... pnpm db:migrate` from the repo (needs dev deps for `drizzle-kit`).
- New migrations are added by `pnpm db:generate` after schema changes (dev), committed under `server/db/migrations/`.

## 9. Backups (out-of-band — not built into the app)
Per the project's locked decision, backups are external. Schedule on the host:
```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U mymind mymind | gzip > /backups/mymind-$(date +%F).sql.gz
```
Also back up the **uploads volume** (`mymind-uploads`) — image/file blobs are NOT in Postgres. A DB restore without the blobs leaves broken image links.

## 10. Post-deploy verification
```bash
ORIGIN=https://mymind.example.com
# health: app responds, redirects unauthed to /login
curl -s -o /dev/null -w '%{http_code}\n' $ORIGIN/login            # 200
# sign in, create a doc, embed, semantic search
curl -s -c /tmp/cj -X POST $ORIGIN/api/auth/sign-in/email -H 'content-type: application/json' \
  -d '{"email":"<you>","password":"<pw>"}' -o /dev/null
curl -s -b /tmp/cj -X POST $ORIGIN/api/documents -H 'content-type: application/json' \
  -d '{"path":"/input/deploy-check.md","content":"# pgvector deploy check"}' >/dev/null
curl -s -b /tmp/cj -X POST $ORIGIN/api/admin/embed-run | jq .      # {embedded>=1}
curl -s -b /tmp/cj "$ORIGIN/api/documents/search?q=vector%20database" | jq 'length'  # >=1
# MCP (with a bearer token from §5)
curl -s -H "Authorization: Bearer $TOKEN" -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' -X POST $ORIGIN/api/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300   # lists ~10 tools
```
Then in a browser: sign in, open Documents/Gallery/Tasks/Memory/Sessions/Clipboard, and confirm the ⌘K palette searches.

## 11. Connecting clients
- **ShareX/CleanShot**: custom uploader → `POST {ORIGIN}/api/upload?public=1`, multipart field `file`, header `Authorization: Bearer <token>`, response URL = `$json:url$`.
- **Claude Code / Hermes hooks**: `POST {ORIGIN}/api/hooks/cc/{event}` (session) + `POST {ORIGIN}/api/hooks/cc/transcript` (`{external_id, lines:[jsonl…]}`), bearer token.
- **MCP**: point the client at `{ORIGIN}/api/mcp` with the bearer token (StreamableHTTP).

## 12. Gotchas (learned the hard way — see handovers)
- **`BETTER_AUTH_URL` must equal the served origin** or sign-in/up returns 403 (origin/CSRF check). The #1 deploy footgun.
- **Embeddings (TEI :8882) are keyless** despite older notes; **vision (:8005, 8B) is weak/flaky** — OCR/transcription lean on the reasoning model.
- **SPA hybrid**: global `ssr:true` + `routeRules '/**': {ssr:false}`, `'/share/**': {ssr:true}`. Don't flip global `ssr:false` (Nuxt 4 then can't re-enable SSR per-route).
- **sharp** needs its native build at image-build time (slim base is fine; build script pre-approved).
- **Single app instance** for the scheduled tasks (see §7).
- Change the **default Postgres password** (`POSTGRES_PASSWORD`) — never ship `mymind/mymind`.

## 13. Not yet built (deploy-relevant backlog)
- No API-token management UI (insert rows manually, §5).
- No in-app backups (external, §9) and no automated blob backup.
- A leaner `.output`-only runtime image (current image keeps full deps so it can self-migrate).
- Bridget memory data migration (importing the old Python service's memories) is not automated.
See the per-cycle handovers in `docs/handovers/` for the full backlog.

## 14. Voice agent

The `/voice` page requires two one-time setup steps and a specific proxy configuration.

### A. Unmute LLM reconfig (one-time, run once)

Unmute is the STT/TTS backend at `192.168.2.25`. Its default LLM URL must be re-pointed to MyMind's agent endpoint so the voice loop runs through Nitro.

Unmute's backend reads `KYUTAI_LLM_URL` (see `unmute/kyutai_constants.py`) and builds
its OpenAI client as `AsyncOpenAI(base_url=KYUTAI_LLM_URL + "/v1")`, then calls
`{base}/v1/chat/completions` and `{base}/v1/models`. MyMind exposes exactly that
surface at `/api/agent/llm/v1/*`, so set `KYUTAI_LLM_URL` to MyMind's host **without**
the `/v1` (Unmute appends it):

```bash
ssh tony@192.168.2.25
cd ~/unmute
# In docker-compose.yml, the backend service env:
#   KYUTAI_LLM_URL=http://<mymind-lan-ip>:3000/api/agent/llm   # homelab prod = http://192.168.2.89:3000/api/agent/llm
#   KYUTAI_LLM_MODEL=<any non-empty string; MyMind ignores it and uses its own AI_REASONING_MODEL>
#   KYUTAI_LLM_API_KEY=<empty or any dummy; the endpoint is keyless, proxy/LAN-restricted>
# Then restart just the backend:
docker compose up -d backend
```
> The MyMind side resolves the real model from its `AI_REASONING_*` env. That base URL
> **must include `/v1`** (e.g. `http://192.168.2.25:8004/v1`) or the loop 404s the model.

After restarting, run the WebSocket smoke test from `docs/wiki/voice-agent-integration.md §11` to confirm the protocol path is intact before adding audio.

### B. Client env var

Set this in `.env` (and in the container env for prod):

| Var | Example | Notes |
|---|---|---|
| `NUXT_PUBLIC_UNMUTE_URL` | `wss://unmute.example.com` | WebSocket base URL the browser connects to. Exposed as `runtimeConfig.public.unmuteUrl`. For dev via localhost tunnel: `ws://localhost:8080`. |

The mic requires a **secure context**: HTTPS or `localhost`. On plain `http://` the browser will refuse `getUserMedia` before the WebSocket opens.

### C. Reverse-proxy security rules (REQUIRED)

`/api/agent/llm` is **unauthenticated and can mutate data** (it runs the full tool-calling loop). It is defended in-handler by an `isPrivateAddress` check, but that check reads `X-Forwarded-For`, which is spoofable unless the proxy enforces both of the following rules:

**Rule 1 — allow-list by source IP:**
Only forward requests to `/api/agent/llm` that originate from the Unmute host (192.168.2.25) or the LAN. Deny all requests to that path coming from the public internet.

Example Caddyfile snippet:
```
mymind.example.com {
    @agent_llm path /api/agent/llm
    @lan_only  remote_ip 192.168.2.25 10.0.0.0/8 192.168.0.0/16 172.16.0.0/12 127.0.0.1

    handle @agent_llm {
        @blocked not remote_ip 192.168.2.25 10.0.0.0/8 192.168.0.0/16 172.16.0.0/12
        respond @blocked 403
        reverse_proxy 127.0.0.1:3000
    }

    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

**Rule 2 — overwrite `X-Forwarded-For`:**
The in-handler check calls `getRequestIP(event, { xForwardedFor: true })`. A client-supplied `X-Forwarded-For: 192.168.2.25` header would bypass it if the proxy forwards it unchanged. The proxy must **overwrite** (not append) `X-Forwarded-For` with the real remote IP so the header cannot be spoofed.

In Caddy, `reverse_proxy` sets `X-Forwarded-For` to the actual client IP by default (override mode). In nginx, use `proxy_set_header X-Forwarded-For $remote_addr;` (not `$proxy_add_x_forwarded_for`).

The other `/api/agent/*` routes (`activity`, `undo`, `chat`) use the standard session/bearer auth and require no special proxy rules beyond the existing ones for `/api/**`.

## 15. CI/CD pipeline (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push:
- **test** (GitHub-hosted): `pnpm install --frozen-lockfile`, lint (non-blocking — repo is
  red), `typecheck`, `test`, `build`. Gates the deploy.
- **deploy** (self-hosted on `mini`, `master` only): syncs the checked-out tree into LXC
  114 at `/opt/mymind` via a `tar | pct exec 114 -- tar -x` pipe (preserves `.env` and the
  Docker volumes), then `docker compose -f docker-compose.prod.yml up -d --build`. The
  Dockerfile runs `pnpm db:migrate` on start, so migrations apply automatically. A
  `/login` health check (200, 30×5s retries) must pass or the job fails.

### One-time: register the self-hosted runner on `mini`

The deploy job needs a runner **on the Proxmox host** (it must call `pct`). Run on `mini`
as a user that can invoke `pct` (root, or a sudoers `pct` entry):

```bash
# On the host `mini` (192.168.2.50):
mkdir -p /opt/actions-runner && cd /opt/actions-runner
# Get the latest runner tarball URL + a registration token from:
#   GitHub repo → Settings → Actions → Runners → New self-hosted runner (Linux x64)
curl -o actions-runner.tar.gz -L <RUNNER_TARBALL_URL>
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/<owner>/<repo> --token <REG_TOKEN> --labels proxmox --unattended
# Install + start as a service so it survives reboots:
./svc.sh install
./svc.sh start
```

Verify in GitHub → Settings → Actions → Runners: the runner shows **Idle** with label
`proxmox`. `tar` and `curl` are already on the host. The deploy job targets
`runs-on: [self-hosted, proxmox]`, so the label must match exactly.

> **Note:** `/opt/mymind` on LXC 114 is the deploy target. It is a plain copied tree (not a
> git checkout); the pipeline overwrites tracked files but leaves `.env`, `.env.bak-*`, and
> the Docker volumes alone. Files **deleted** from the repo are not removed from
> `/opt/mymind` (tar-extract limitation) — clean stale files by hand if it ever matters.
