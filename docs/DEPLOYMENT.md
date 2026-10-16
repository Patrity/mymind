# MyMind — Deployment Guide

> Audience: an agent or operator deploying MyMind to the homelab (Proxmox + Docker), internet-exposed.
> Source of truth for **how the app works** is `docs/wiki/`; this doc is **how to run it**. If anything here disagrees with the code, the code + the newest `docs/handovers/` win — update this doc.

> **Cycle 86: prod moves to the Mac mini** (launchd, user `bridget` @ `192.168.2.35`, DB on `192.168.2.80`); LXC 114 becomes the CI build box. Status: **deployed 2026-10-13/14** (cutover done) (see the [handover](handovers/2026-10-13-macmini-host.md)). See **§23** and the `prod-deploy` skill. §§17–21 describe the LXC 114 runtime (`DEPLOY_TARGET=lxc`), kept until cutover + 7 days; §14 (host `exec`) and §22 (the Docker sandbox) are **retired** and kept as history only.

## 0. What you're deploying

MyMind is **one Nuxt 4 service** (Nitro `node-server`) plus, since cycle 81, a separate **agent
worker** process (`mymind-worker`, the only process that executes Bridget's runs — see §21). The web serves:
- the **web app** (SPA for the authed UI; SSR only for public `/share/**` pages),
- **HTTP endpoints** (uploads for ShareX/CleanShot, Claude Code / Hermes hook ingestion),
- an **MCP server** at `POST /api/mcp` for agents.

It depends on:
- **PostgreSQL 16 + pgvector** (extensions: `pgcrypto`, `pg_trgm`, `ltree`, `vector`).
- A **persistent uploads volume** (content-addressed image/file blobs).
- The **local AI rig** at `192.168.2.25` (LAN) — embeddings (TEI :8882, keyless), reasoning (:8004), vision (:8005). Providers/models are configured **in-app** (the AI config registry — DB-backed, edited at `/settings`, see `docs/wiki/ai-providers.md`), not by env. The app boots without any model configured; AI features just stay unconfigured until you complete `/onboarding`.
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
#    Optional: AI_* endpoints — NOT runtime config; only a one-time seed for the
#      onboarding "Import from environment" button (see §4a + §15a). Models are
#      configured in-app at /settings after first sign-in.
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
| `BETTER_AUTH_SECRET` | ✅ | 32+ bytes. `openssl rand -base64 48`. **Rotating it** makes every stored Google token undecryptable — each Google connection goes `needs_reconnect` on its first call after the rotation; Reconnect each account (see §20). |
| `BETTER_AUTH_URL` | ✅ | **public origin**, must match how users reach it (proxy origin). Mismatch → sign-in/sign-up 403 (CSRF/origin check). |
| `ALLOW_SIGNUP` | bootstrap | `true` to enable account creation; **unset after** creating your account. |
| `CONFIG_ENC_KEY` | optional | Key used to encrypt provider API keys at rest in the AI config registry (AES-256-GCM). Raw 32-byte **base64** (`openssl rand -base64 32`). **If unset, the key is derived from `BETTER_AUTH_SECRET` via HKDF** — so you do not need to set this. Set it only if you want the config-secret key independent of the auth secret. A non-32-byte value throws on first AI-config write. |
| `NUXT_GOOGLE_CLIENT_ID` / `NUXT_GOOGLE_CLIENT_SECRET` | optional | Google OAuth client for Settings → Connections (cycle 79). Both unset ⇒ no Google provider; the Connections page shows a not-configured notice and Bridget's gmail/calendar toolsets stay hidden. Setup: §20. |
| `MEMORY_AUTO_REVIEW_THRESHOLD` | optional | default `0.75`; memories ≥ this auto-review. |
| `STORAGE_DRIVER` / `STORAGE_LOCAL_DIR` | ✅ | `local` + `/app/.data/uploads` (a mounted volume in compose). `s3` + `STORAGE_S3_*` to use S3. |
| `MAX_UPLOAD_BYTES` | optional | default 50 MB. |
| `NITRO_PORT` / `NITRO_HOST` | optional | default `3000` / `0.0.0.0`. |
| `AGENT_RUNTIME_EXCLUSIVE` | prod: `1` | Set in `deploy/mymind.service`. Declares this process the **only** agent runtime on the database, so boot recovery marks every `running` agent run claimed by a previous boot (`agent_runs.owner` ≠ this boot's id) `interrupted` at once, instead of waiting the 60 s orphan threshold — without it a deploy restart leaves the thread "busy" (messages steered into a dead run) for up to a minute. **Leave unset anywhere the DB is shared** (the dev DB, worktrees): another checkout's live server owns genuinely running runs there. |
| `AI_<ROLE>_BASE_URL / _API_KEY / _MODEL` | optional (seed) | **NOT runtime config** — see §4a. Leftover roles (`REASONING`, `BULK`, `EMBEDDINGS`, `VISION`, `STT`, `TTS_BREEZE`, `RERANK`) are a **one-time onboarding seed** consumed only by the `/onboarding` "Import from environment" button. Safe to leave set (pre-fills the registry on first run) or to omit (configure in `/settings` by hand). |

### 4a. AI models are configured in-app, not by env

Model/provider config moved out of env into the **AI config registry** (a DB-backed JSONB doc; `docs/wiki/ai-providers.md`). Providers, models, and per-usage failover chains are edited at **`/settings`** (Providers / Models / Model Configuration tabs). API keys are stored **encrypted at rest** (`CONFIG_ENC_KEY` above) and are never returned to the client.

On first sign-in the app **redirects to `/onboarding`** until at least `reasoning` and `embeddings` each have an assigned model. The onboarding wizard reuses the settings tabs and offers an **"Import from environment"** button: if you left the old `AI_*` vars in `.env`, it seeds the registry from them in one click (one-time; it overwrites an empty config), then encrypts the keys. Otherwise add providers/models by hand. After onboarding, the `AI_*` env vars do nothing at runtime.

Embeddings stay fixed at **2560-dim** (`qwen3-embedding-4b`, TEI `:8882`, keyless). On save the registry runs a **dim-probe** against the primary embedding model's `/embed` and rejects the config (422) unless it returns exactly 2560 dims — so the deploy host **must reach a working 2560-dim embedding endpoint** before you can finish onboarding.

### 4b. REQUIRED before voice works — repoint `assignments.tts` at Breeze (cycle 61)

**This is a hard prerequisite, not a note. Skip it and voice is dead on arrival — both surfaces.**

Cycle 61 replaced the whole TTS stack with a single engine, **Breeze TTS 2** at `:8880`, and
**deleted the TTS failover chain**. `speakWithPreset` (`packages/core/src/lib/voice/speak.ts`) resolves
`chain[0]` of the registry's `tts` assignment and **stops** — there is nothing behind it to fall
back to. Both callers go through it:

- `server/api/voice/ws.ts:52` — **the live agent**, so every spoken reply in a conversation;
- `server/api/voice/speak.post.ts` — the `/voice` studio, so every render and every audition.

Prod's `ai_config` registry row still lists the **decommissioned** engines (Kokoro `:8880` under its
old label, Chatterbox `:8884`, Orpheus `:5005`) and will almost certainly have one of them **first**.
Nothing migrates it: the registry is a `settings` JSONB row edited in the app, and no migration in
this branch touches it. Until it is repointed by hand, **every spoken agent reply and every studio
render fails with `502 "Breeze unreachable at http://<dead host>: fetch failed"`**, with no fallback
and no degraded mode. The text side of the agent keeps working, which is exactly what makes this easy
to miss.

This was confirmed on the dev box during cycle 61's browser validation: the assignment read
`[chatterbox@:8884, kokoro@:8880]`, `:8884` had been dead since the rig was repurposed, and every
render 502'd until the assignment was fixed.

**Check it (read-only):**

```bash
ssh root@192.168.2.50 "pct exec 114 -- docker exec mymind-db psql -U mymind -d mymind -t -c \
  \"select jsonb_pretty(value->'assignments'->'tts') from settings where key='ai_config'\""
```

Then confirm the first id in that array is a model whose provider `baseURL` is the Breeze rig:

```bash
ssh root@192.168.2.50 "pct exec 114 -- docker exec mymind-db psql -U mymind -d mymind -t -c \
  \"select m->>'label', p->>'baseURL' from settings s,
       jsonb_array_elements(s.value->'models') m,
       jsonb_array_elements(s.value->'providers') p
     where s.key='ai_config' and p->>'id' = m->>'providerId'
       and m->>'id' = (s.value->'assignments'->'tts'->>0)\""
```

Expected: one row naming the Breeze provider, `http://192.168.2.25:8880/v1`.
Anything else — `chatterbox`, `:8884`, `:5005`, or an empty result — means voice is broken.

**Fix it — preferred: in the app.** `/settings` → **Model Configuration** → **tts**: remove every
retired entry and leave exactly **one** model, pointed at the Breeze provider. Doing it here also
invalidates the registry's in-process cache, so it takes effect immediately.

**Fix it — direct SQL** (if the UI is unreachable). The registry cache is **process-local with
explicit invalidation**, so a direct row edit is not seen until the service restarts:

```bash
# … after updating settings.value->'assignments'->'tts' to a single Breeze model id …
ssh root@192.168.2.50 "pct exec 114 -- systemctl restart mymind"
```

**Verify:** the rig answers `curl -s http://192.168.2.25:8880/health` →
`{"status":"ok","sample_rate":24000}` (a 503 means it is still warming — roughly 44 s cold). Then
open `/voice`, select a preset and press **Speak**: a working path renders a first-audio time in
well under a second. If it 502s, the message names the host actually being dialed — read it, because
it is the fastest way to see a stale assignment.

## 5. Bootstrap the account + machine tokens

Sign-up is disabled by default (single-user, internet-exposed). To create the first account:
1. Set `ALLOW_SIGNUP=true` in `.env`, `docker compose -f docker-compose.prod.yml up -d app` (recreate).
2. Visit `https://<origin>/login` → "Create account" → register. You're signed in.
3. Set `ALLOW_SIGNUP=` (empty) and recreate the app container. (UI toggle hides AND the API rejects sign-up when off.)
4. After sign-in you're redirected to **`/onboarding`** — configure AI models (Import from environment, or add providers/models by hand) until `reasoning` + `embeddings` are assigned, then Finish. See §4a.

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
- `POST /api/channels/bluebubbles/webhook?token=…` (cycle 75, BlueBubbles; self-authenticating by token, 404 otherwise — see §19)
Rate-limit `/api/auth`, `/api/upload`, and `/api/hooks` at the proxy.

## 7. Background scheduled tasks

These run **in-process** while the app is up (Nitro `scheduledTasks`). The agent's own tasks
(`summarize-threads`, `reflect-threads`, `reflect-jobs`) moved to the agent worker in cycle 81 (§21):
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

### 8a. Running scripts / DB ops against prod (no exposed DB port)
The homelab prod DB (`mymind-db`) publishes **no host port** — only the app reaches it on the compose network (`mymind_default`, host `db:5432`). Prod runs in **LXC 114** on Proxmox host **192.168.2.50** (LXC LAN IP **192.168.2.89**). Three recipes:
- **Read-only SQL / quick fixes** — `ssh root@192.168.2.50` then `pct exec 114 -- docker exec mymind-db psql -U mymind -d mymind -c '…'` (in-container trust auth; no password). Multi-statement clears: pipe SQL via `… | pct exec 114 -- docker exec -i mymind-db psql -U mymind -d mymind`.
- **Run a node script inside the app container** — `mymind-app` has `node` + `pg` + the source tree, but **NOT `tsx`** (the pnpm `.bin/tsx` symlink isn't present). So write a **self-contained `.mjs`** (plain JS, helpers inlined, `import pg from 'pg'`), ship it in via `base64 < x.mjs | ssh … "pct exec 114 -- docker exec -i mymind-app sh -c 'base64 -d > /app/x.mjs'"`, then `pct exec 114 -- docker exec -w /app mymind-app node x.mjs`. `DATABASE_URL` is already in the container env. `rm` it after.
- **Run a LOCAL script against prod** (when the source must stay local — e.g. the bridget import needs the local-only bridget DB) — stand up a **temporary** tunnel, then tear it down:
  ```bash
  ssh root@192.168.2.50 "pct exec 114 -- docker run -d --rm --name pg-tunnel --network mymind_default -p 5432:5432 alpine/socat tcp-listen:5432,fork,reuseaddr tcp:mymind-db:5432"
  # prod Postgres is now at 192.168.2.89:5432 (password-required); run your local script with
  #   PGPASSWORD=$(ssh root@192.168.2.50 "pct exec 114 -- sh -c 'grep ^POSTGRES_PASSWORD= /opt/mymind/.env | cut -d= -f2-'") \
  #   DATABASE_URL=postgres://mymind@192.168.2.89:5432/mymind  node_modules/.bin/tsx scripts/<x>.ts
  ssh root@192.168.2.50 "pct exec 114 -- docker rm -f pg-tunnel"   # ALWAYS tear down
  ```
  Never echo `POSTGRES_PASSWORD`; pg falls back to `PGPASSWORD` when the URL omits the password. **Deploy detection:** after a push, poll `docker inspect mymind-app --format '{{.State.StartedAt}}'` for a change to know the rebuild landed.

### 8b. Seeding agent skills after deploy
The CD pipeline does not run `scripts/seed-skills.ts` — it's manual (deliberately: skills are content, not schema, and re-running it is always safe/idempotent). After a deploy that touches the seed set (or on first cutover), run it on the box:
```bash
pct exec 114 -- bash -lc 'cd /opt/mymind && node_modules/.bin/tsx --env-file=.env.native scripts/seed-skills.ts'
```
**Use `.env.native`, not `.env`** — that's prod's runtime env file (see §18); `.env` is dev-only and won't have the prod `DATABASE_URL`. `pnpm install` (no `--prod`) in the CD pipeline keeps `tsx` available at `/opt/mymind/node_modules/.bin/tsx`. Locally / in dev, the equivalent is `pnpm seed:skills` (reads `.env`).

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
```bash
# voice: the ONE check that catches a stale `assignments.tts` (see 4b) — a text-only
# smoke test passes while every spoken reply is 502ing.
curl -s http://192.168.2.25:8880/health                            # {"status":"ok","sample_rate":24000}
curl -s -b /tmp/cj "$ORIGIN/api/voice/presets" | jq '.presets | length'   # 8 after migration 0039
PID=$(curl -s -b /tmp/cj "$ORIGIN/api/voice/presets" | jq -r '.presets[0].id')
curl -s -b /tmp/cj -D- -o /dev/null -X POST $ORIGIN/api/voice/speak -H 'content-type: application/json' \
  -d "{\"text\":\"deploy check\",\"presetId\":\"$PID\"}" | grep -i 'HTTP/\|x-sample-rate'
# expect: 200 + `x-sample-rate: 24000`.
# a 502 naming a host that is NOT :8880 means `assignments.tts` was never repointed — see 4b.
```

Then in a browser: sign in, open Documents/Gallery/Tasks/Memory/Sessions/Clipboard, and confirm the ⌘K palette searches. Open `/voice`, pick a preset and press **Speak** — and send one turn on `/agent` with voice replies on, because the live agent and the studio share `speakWithPreset` and a stale `tts` assignment silences both.

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

## 13. Web search (Brave)

Search is **Brave Search API only** (cycle 86; the bundled SearXNG service is retired). The API key and
the rate limit (`search.brave.qps`, default 1 req/s, burst 3) are set in-app at **`/settings → Search`** —
no env vars. See `docs/wiki/web-research.md`.

## 14. Agent exec tool (retired in cycle 86)

Host `exec`, its approval allowlist, `EXEC_WORKSPACE_DIR`/`EXEC_TIMEOUT_MS`/`EXEC_UNCONFINED` and the
`/opt/mymind/workspace` directory are **gone**: Bridget's commands run through the `workspace` toolset as
plain host processes on the Mac mini (no approval, no confinement; see `docs/wiki/workspace.md`).
Nothing here needs configuring. The encrypted `exec_secrets` store (Settings → Secrets) survives: its
per-secret **Bridget's shell** switch controls which secrets reach her shell. History:
`docs/wiki/agent-exec.md` (retired).

## 15. Not yet built (deploy-relevant backlog)
- No API-token management UI (insert rows manually, §5).
- No in-app backups (external, §9) and no automated blob backup.
- A leaner `.output`-only runtime image (current image keeps full deps so it can self-migrate).
- Bridget memory data migration (importing the old Python service's memories) is not automated.
See the per-cycle handovers in `docs/handovers/` for the full backlog.

## 16. Voice agent

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
#   KYUTAI_LLM_URL=http://<mymind-lan-ip>:3000/api/agent/llm   # homelab prod = http://192.168.2.35:3000/api/agent/llm (the Mac mini since cycle 86; was LXC 114's .89)
#   KYUTAI_LLM_MODEL=<any non-empty string; MyMind ignores it and resolves its own reasoning model>
#   KYUTAI_LLM_API_KEY=<empty or any dummy; the endpoint is keyless, proxy/LAN-restricted>
# Then restart just the backend:
docker compose up -d backend
```
> The MyMind side resolves the real model from the **AI config registry** (the `reasoning`
> usage chain — configured at `/settings`), not from env. The provider base URL set there
> **must include `/v1`** (e.g. `http://192.168.2.25:8004/v1`) or the loop 404s the model.
>
> NOTE: voice v2 (cycle 18) removed the Unmute stack in favor of a self-hosted TS pipeline —
> this §14a Unmute reconfig is retained for reference but is superseded; see
> `docs/handovers/2026-06-09-voice-v2.md`.

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

## 17. CI/CD pipeline (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push:
- **test** (GitHub-hosted): `pnpm install --frozen-lockfile`, lint (non-blocking — repo is
  red), `typecheck`, `test`, `build`. Gates the deploy.
- **deploy** (self-hosted on `mini`, `master` only): syncs the checked-out tree into LXC
  114 at `/opt/mymind`, then runs the **native** flow (B3.1) — `docker compose up -d
  --remove-orphans db` (Postgres stays a container; the app is **not** a
  container), `deploy/provision-native.sh` (idempotent), `pnpm install`/`build`, `pnpm
  db:migrate` (sourcing `.env.native`), then `systemctl restart mymind`. A `/login` health
  check (200, 30×5s retries) gates success. **See §18 for the native model** — §3's `docker
  compose up --build app` flow is legacy/rollback only.

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
> git checkout); the pipeline overwrites tracked files but leaves `.env`, `.env.native`,
> `.data`, `workspace`, and the Docker volumes alone. Files **deleted** from the repo are not
> removed from `/opt/mymind` (tar-extract limitation) — clean stale files by hand if it ever matters.

## 18. Native deploy (B3.1 — app runs outside Docker)

As of **B3.1** the app runs **natively** as a `systemd` service in LXC 114, **not** as a Docker
container, so the agent's `exec` runs in the LXC directly. **`db` (Postgres/pgvector) stays a
Docker container** (Postgres published on `127.0.0.1:5432`); the corpus volume
`mymind-pgdata` is never migrated. The §3 / §17 `docker compose up --build app` flow is **legacy**
(kept for rollback); the `Dockerfile` is retired.

**Runtime:** `deploy/mymind.service` runs `node /opt/mymind/.output/server/index.mjs` as **root**
(the unprivileged LXC is the boundary), `Restart=always`. It loads `/opt/mymind/.env` then
`/opt/mymind/.env.native` (native overrides win):

```
DATABASE_URL=postgres://mymind:<POSTGRES_PASSWORD>@127.0.0.1:5432/mymind
STORAGE_LOCAL_DIR=/opt/mymind/.data/uploads
NITRO_PORT=3000
NITRO_HOST=0.0.0.0
# runtimeConfig overrides — REQUIRED at runtime (see the runtimeConfig gotcha below):
NUXT_DATABASE_URL=postgres://mymind:<POSTGRES_PASSWORD>@127.0.0.1:5432/mymind
NUXT_STORAGE_LOCAL_DIR=/opt/mymind/.data/uploads
```
`.env.native` is on-box only (gitignored via `.env.*`) and is preserved by the deploy sync.

**`NITRO_HOST` must be `0.0.0.0`** — the reverse proxy (Pangolin) reaches the app by the LXC's
IP, so a loopback (`127.0.0.1`) bind 502s externally even though the in-LXC `localhost`
health-check passes. `provision-native.sh` self-heals an existing loopback `.env.native`.

**The `NUXT_DATABASE_URL` gotcha (cost us a prod incident).** `useDb()` reads
`useRuntimeConfig().databaseUrl`, and `nuxt.config` defines `databaseUrl: process.env.DATABASE_URL`.
Nuxt **bakes `runtimeConfig` at build time** from the build-time `.env` (which has `@db:5432`, the
Docker hostname). At runtime, a plain `DATABASE_URL` env var does **not** override a `runtimeConfig`
key — **only the `NUXT_`-prefixed `NUXT_DATABASE_URL` does**. So a native deploy that sets only
`DATABASE_URL` leaves the app dialing the build-baked `@db` (which resolves via DNS search to a
public IP → `ECONNREFUSED`); `migrate` still works because drizzle reads `process.env.DATABASE_URL`
directly. The tell: `/login` returns 200 (SSR, no DB) but every **authenticated** API call (`/api/mcp`,
`/api/hooks/cc/*`) 500s — the auth middleware's `api_tokens` lookup is the first DB hit.
`provision-native.sh` writes/self-heals `NUXT_DATABASE_URL` + `NUXT_STORAGE_LOCAL_DIR`. **Health
checks must hit an authenticated endpoint, not just `/login`**, to catch this class of failure.

**First cutover:** merge to master — the CD `deploy` job runs `deploy/provision-native.sh`
(idempotent), which installs Node 22 + pnpm, writes `.env.native` (deriving the PG password from
`.env`), **migrates the `mymind-uploads` Docker volume → `/opt/mymind/.data/uploads`** (one-time),
and installs+enables the unit. For a deliberate first cutover you can run it by hand first:
`pct exec 114 -- bash -lc 'cd /opt/mymind && bash deploy/provision-native.sh'`.

**Each deploy** (CD `deploy` job): sync tree → `docker compose up -d --remove-orphans db`
(`--remove-orphans` drops the old `app` container, freeing `:3000`) → `provision-native.sh` →
`pnpm install`/`build` → `pnpm db:migrate` (sources `.env.native`) → `systemctl restart mymind` →
`/login` health check.

**Ops:** `systemctl status mymind`, `journalctl -u mymind -f` for the app; `docker ps` shows only
`mymind-db`. The in-process Nitro `scheduledTasks` (embeddings, enrichment,
prune) run inside the native process — no separate cron.

**Rollback:** the previous app image is still on the box. Restore the docker-app by checking out
the pre-B3.1 `docker-compose.prod.yml` (with the `app` service) + `docker compose up -d --build app`,
then `systemctl stop mymind`. Keep until the native deploy is confirmed stable.

> **Note:** post-B3.1 the `exec` tool returns **`disabled`** (fail-closed) until **B3.2** reworks
> the runner for the native root-in-LXC model. The approval gate, allowlist, and
> `/settings → Agent Tools` UI remain intact.

## 19. Bridget channels — iMessage (BlueBubbles) + email (Resend) (cycle 75)

Full reference: [`docs/wiki/channels.md`](wiki/channels.md). Migrations **0057** (tables) and
**0058** (an index on `channel_deliveries.conversation_id`) are additive and run with the normal CD
`pnpm db:migrate`. **There are no new env vars on prod.** All
configuration lives in the DB and is set in the app. (`BLUEBUBBLES_FAKE_URL` and `RESEND_FAKE` are
dev-only; never set them on the server. `RESEND_FAKE` is inert in a production build anyway.)

**Network reachability runs both ways.**
- **Prod → BlueBubbles:** LXC 114 must reach the Mac's BlueBubbles server (for example
  `http://<mac-lan-ip>:1234`) for sends, the 2-minute catch-up, typing/read receipts and attachment
  downloads. Check it from the box:
  `pct exec 114 -- curl -s "http://<mac-lan-ip>:1234/api/v1/server/info?password=<pw>"`.
- **BlueBubbles → prod:** the Mac must reach the webhook. Use either the LAN URL
  `http://192.168.2.35:3000/api/channels/bluebubbles/webhook?token=<token>` (the Mac mini; LXC 114's
  `.89` before cycle 86) or the public
  `https://brain.costanzoclan.com/api/channels/bluebubbles/webhook?token=<token>`. The path is exempt
  from session auth (the token is the credential; a bad token is a 404). The reverse proxy must pass
  it through, including the query string. If the webhook can't get through, the catch-up still
  delivers every message within about 2 minutes.

**One BlueBubbles server ↔ one MyMind.** The 2-minute catch-up polls BlueBubbles whether or not a
webhook is registered, so if dev and prod are both enabled against the same BlueBubbles server,
**both answer every text**. Before enabling iMessage on prod, switch it off on dev (Settings →
Channels → iMessage off, or restore dev's settings after any real-phone session), and never run a
real-phone check on dev while prod's iMessage is enabled.

**Catch-up bounds.** On a fresh install (no inbound rows yet) the catch-up starts 5 minutes back,
so prod does not replay texts dev already answered; and it never reads back more than 24 hours,
so enabling iMessage after a long gap (or recovering from a long outage) does not answer a backlog
of old texts one by one. Texts older than that are simply never answered — tell Tony to re-send.

**One-time setup after the deploy:**
1. **Settings → Bridget → Agent timezone** = `America/Chicago` (cycle 74). Never rely on a host clock's zone:
   since cycle 86 the mini runs local time (CDT), the `.80` database is UTC, and every Tony-facing time
   goes through `agent_timezone`.
   Do this before enabling any job.
2. **Settings → Activity & Alerts:** Resend API key + sender address (email needs both).
3. **Settings → Channels:** enable iMessage, enter the Server URL + password, add the allowed
   handle(s), pick the default handle, and Save. Enable Email with the **Send to** address. Presence
   defaults to 10 min.
4. **Test connection** → confirm the green **Private API on** badge. Amber (Private API off) still
   sends texts via AppleScript, but there are no tapbacks, typing indicators, or tapback approvals.
5. Copy the **Webhook URL** from Settings → Channels (it is built from the origin you are browsing;
   swap in the LAN origin if you prefer it). In the BlueBubbles server app: **Settings → API &
   Webhooks → Add**, paste it, and tick **New Messages** and **Message Updates**.
6. **Send test message** / **Send test email**, then text Bridget from the phone.

**Heads-up:** a job with no `deliver:` line now means `deliver: [auto]` (it texts Tony when he is
away from the app). Prod has no enabled jobs yet, but review any custom job before enabling it.

**Ops:** the Settings → Channels nav dot (green / amber / red; neutral grey right after boot or
after saving a new server, until the first check), `GET /api/channels/status`, and
`journalctl -u mymind | grep '\[channels\]'`. The stuck-delivery and recent-inbound queries are in
the wiki page. **Regenerating the webhook token** breaks the registered webhook until the new URL
is pasted into BlueBubbles.

## 20. Google connections — Gmail, Calendar, Contacts (cycle 79)

Design: [`docs/superpowers/specs/2026-10-05-google-connections-design.md`](superpowers/specs/2026-10-05-google-connections-design.md). Migration **0067** (the
`connections` table) is additive and runs with the normal CD `pnpm db:migrate`. The feature ships
**invisible**: with no Google client configured, Settings → Connections shows "Google is not
configured on this server" and Bridget's `gmail` / `calendar` toolsets are left out of her directory.
Google is a **linked** account only — never a sign-in method.

**One-time setup checklist (Tony).** Google's console calls the OAuth area **Google Auth Platform**
(console.cloud.google.com → ☰ → *Google Auth Platform*); its left nav is **Overview / Branding /
Audience / Clients / Data Access / Verification Center**. The older "APIs & Services → OAuth consent
screen / Credentials" pages redirect there.
1. **GCP project** → create or pick a project → **APIs & Services → Library** → enable **Gmail API**,
   **Google Calendar API** and **People API**. (People not enabled shows up as a plain Google 403 on
   `contacts_search`, not as a reconnect.)
2. **Google Auth Platform → Branding** → app name + user support email + developer contact email.
3. **Audience** → User type **External**. Then **Publish app** (status *In production*) and leave it
   **unverified**. In *Testing* status Google expires refresh tokens after **7 days**, and every
   connection would go `needs_reconnect` weekly; unverified-in-production has no such expiry.
   An unverified app requesting sensitive/restricted scopes is capped at **100 users** (lifetime) and
   shows the "Google hasn't verified this app" warning, which the personal account clicks through
   once (Advanced → Go to …) when linking. Two accounts are nowhere near the cap.
4. **Data Access → Add or remove scopes** → add:
   `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.modify`,
   `https://www.googleapis.com/auth/calendar.events`,
   `https://www.googleapis.com/auth/calendar.readonly`,
   `https://www.googleapis.com/auth/contacts.readonly`,
   `https://www.googleapis.com/auth/contacts.other.readonly` → Save.
5. **Clients → Create client → Web application**, with both **Authorized redirect URIs**:
   - `https://brain.costanzoclan.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
   (The callback is built from `BETTER_AUTH_URL`; a dev server on another port needs its own URI
   added here.) Copy the client id and secret (the secret is only shown in full at creation).
6. **Before linking the work account — Workspace admin trust.** admin.google.com → **Security →
   Access and data control → API controls → Manage Third-Party App Access → Configure new app** →
   search for the OAuth **client id** → scope: all of the org (or Tony's OU) → **Trusted**. Do this
   BEFORE the first link: without it Workspace blocks the restricted Gmail scope ("Access blocked"
   or a consent screen missing Gmail), and an account linked that way must be disconnected and
   re-linked after trusting.
7. On prod, add to `/opt/mymind/.env.native` and restart:
   ```bash
   NUXT_GOOGLE_CLIENT_ID=<client id>
   NUXT_GOOGLE_CLIENT_SECRET=<client secret>
   ```
   `pct exec 114 -- systemctl restart mymind`. (The `NUXT_` prefix is required — these are
   `runtimeConfig.googleClientId/googleClientSecret`; see the runtimeConfig gotcha in §18.)
8. **Settings → Connections → Connect Google account** for each account (work Workspace, then
   personal). Grant **every** permission on the consent screen. A card whose scope badges show a
   missing service was linked with a box unticked — Bridget's tools then answer "your <label>
   account didn't grant <service> access — reconnect it …" for that service only (the others keep
   working): Disconnect and connect again, ticking every box. Rename the labels if you like; the
   label is the `account` name Bridget's tools use.
9. Acceptance: ask Bridget for today's calendar and for a recent email from each account.

**Rotating `BETTER_AUTH_SECRET`** re-keys the at-rest encryption of the stored Google access and
refresh tokens (`encryptOAuthTokens`), so the old tokens no longer decrypt. better-auth swallows that
failure into a generic "Failed to get a valid access token", so MyMind checks for it itself
(`connectionDeps.tokensUndecryptable` in `packages/core/src/lib/google/connections.ts`): the **first Google
call for each account after a rotation** marks that connection `needs_reconnect` (last error
"stored Google tokens can no longer be decrypted …") and the tool reports the account needs
reconnecting. Connections not yet used since the rotation still show `ok` until their first call.
Fix: **Settings → Connections → Reconnect** each account (re-linking stores fresh tokens under the
new secret). Reconnecting proactively right after a rotation avoids the failed first call.

**Disconnect** revokes the token at Google (`POST https://oauth2.googleapis.com/revoke`, best effort,
logged as `[connections] Google revoke …` on failure) and then deletes the linked account row (the
connection row cascades). If the revoke failed, remove MyMind at myaccount.google.com → Security →
Third-party access.

**Ops:** the Settings → Connections nav item shows an amber chip while any connection is
`needs_reconnect`; the card shows the last error. `journalctl -u mymind | grep '\[connections\]'`.

## 21. Agent worker (`mymind-worker`, cycle 81)

Since cycle 81 the web **never executes an agent run**. A second native process, the agent worker
(`apps/worker`, bundled with esbuild), claims and runs every chat turn, wake, job and workstream
segment, and owns the 5 s runtime tick (recovery, jobs, outbox, iMessage catch-up), the agent cron
tasks and the activity-log flush. The two processes talk only through Postgres (the bus:
`run_events`, `worker_commands`, `worker_heartbeat`, `LISTEN/NOTIFY`). How it works:
[`docs/wiki/agent-runtime.md`](wiki/agent-runtime.md) and [`docs/wiki/workstreams.md`](wiki/workstreams.md).

**Topology (LXC 114):**

| | web | worker |
|---|---|---|
| unit | `mymind` (`deploy/mymind.service`) | `mymind-worker` (`deploy/mymind-worker.service`) |
| runs | `/opt/mymind/.output/server/index.mjs` | `/opt/mymind/.worker/dist/worker.mjs` |
| env | `.env` then `.env.native` | the **same** two files, same order (`MYMIND_BUS_NS`, if set, must match) |
| `AGENT_RUNTIME_EXCLUSIVE=1` | **no** (it never recovers or claims runs) | **yes** (exclusive boot recovery) |
| restart policy | `Restart=always` | `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0` (never parked `failed`) |

Both units are installed and enabled by `deploy/provision-native.sh` (idempotent).

**Release dirs.** The worker runs from a self-contained release (the bundle plus its external
packages' full dependency closure), not from the tree that CD wipes and `pnpm install` rewrites:
`.worker/` (active), `.worker-prev/` (one level of rollback), `.worker-next/` (staged, between
`stage` and `activate`). CD's sync preserves `.worker` and `.worker-prev`. Driven by
`deploy/worker-release.sh stage|activate|rollback`. They take about 620 MB on disk at rest and about
930 MB at peak during a deploy, so run `df -h /` before deploying.

**Deploy order (CD, `deploy.yml`):** sync → db up → provision → install + **web build** +
`worker-release.sh stage` + **cancel running evals** + migrate → `systemctl restart mymind` →
`/api/health` → `worker-release.sh activate && systemctl restart mymind-worker` → worker health
(unit active + a fresh `worker_heartbeat` row from the new boot). The web is cut over first.
Between the two restarts nothing executes (about 1–2 min); queued runs wait in the DB and nothing
is lost.

**Cancel running evals before migrating (cycle 85).** Right before `pnpm db:migrate`, CD runs
(sourcing `.env.native`): `NODE_ENV=production pnpm eval --cancel-all --wait 60 || echo "eval cancel
failed (continuing)"`. This is wrapped in `|| echo`, so it can **never** fail the deploy — a
migration that runs anyway is still safe, because every eval attempt checks for schema drift both
before and after it runs and fails closed if the world doesn't match `public` anymore (see
[`wiki/eval.md`](wiki/eval.md)). **Eval runs use the same prod Postgres instance and the same
`DATABASE_URL` as the app** — each live eval world is its own temporary schema
(`eval_<run>_<suffix>`) inside the `mymind` database, never a separate database or server, so a
migration during an eval run would otherwise be touching the exact schemas (`public`'s tables, and
every world's shadow of them) that eval worlds are built from. Dropped schemas and the eval
tables (`eval_suites`/`eval_cases`/`eval_runs`/`eval_results`) are ordinary rows/objects in the
normal nightly DB dump — nothing eval-specific is excluded from backups. See the ops section in
[`.claude/skills/prod-deploy/SKILL.md`](../.claude/skills/prod-deploy/SKILL.md#evals-on-prod) for
running one safely, checking for leftover `eval_*` schemas/containers, and cancelling by hand.

**Drain.** `systemctl restart|stop mymind-worker` sends SIGTERM. The worker stops claiming, lets
in-flight runs finish for up to 60 s (`WORKER_DRAIN_MS`, inside `TimeoutStopSec=90`), then exits.
A workstream segment yields after its current step and its successor is queued. A segment parked on
an approval card is released, and its card is withdrawn on the next boot (the model re-issues the
call and Tony approves a fresh card). A chat run still going at the deadline is recovered as
`interrupted` at the next boot.

**Crashes.** An unhandled promise rejection is logged and recorded in `activity_log` (`kind=job`,
`name=worker:unhandledRejection`, at most 20 rows a minute), and the worker keeps running. An
uncaught exception is recorded (`worker:uncaughtException`) and triggers a drain bounded at 15 s,
then `exit 1`. systemd restarts the worker 5 s later, with no start limit. An idle pool client error
(e.g. Postgres restarted) is logged (`[db] idle pool client error`) and never crashes the process.
The LISTEN connection reconnects by itself.

**Logs and health:**
```bash
journalctl -u mymind-worker -n 120 --no-pager      # boot line: "[worker] boot <id> pid=… ns=…"
journalctl -u mymind-worker -f
systemctl status mymind-worker --no-pager
# heartbeat (the web's "agent worker offline" banner = newest beat > 30 s old)
docker exec -i mymind-db psql -U mymind -d mymind -c \
  "select boot_id, pid, started_at, beat_at, now() - beat_at as age from worker_heartbeat order by beat_at desc limit 3;"
# trapped crashes
docker exec -i mymind-db psql -U mymind -d mymind -c \
  "select created_at, name, error->>'message' from activity_log where name like 'worker:%' order by created_at desc limit 20;"
du -sh /opt/mymind/.worker /opt/mymind/.worker-prev /opt/mymind/.worker-next 2>/dev/null
```

### 21a. Rollback

Migrations are **never** reverted. Every cycle-81 migration (0068–0071) is additive, and older
code ignores the new tables and columns.

- **Worker only, at cycle ≥ 81** (bad worker release, web fine). This is **one level** (`.worker-prev`):
  ```bash
  cd /opt/mymind && bash deploy/worker-release.sh rollback && systemctl restart mymind-worker
  ```
  The next CD deploy stages and activates a fresh release as usual.
- **Web and worker, at cycle ≥ 81.** Revert on `master` and push; CD redeploys both units in the
  usual order.
- **Rolling back below cycle 81** (to code that has no worker). This is dangerous if done naively.
  The old `mymind.service` brings back `AGENT_RUNTIME_EXCLUSIVE=1` and the in-process executor. A
  still-running worker would then be a **second executor** on the same DB: each process's recovery
  interrupts the other's runs, and the old web would run `kind='workstream'` segments as plain turns.
  The old sync would also delete `.worker/` from under the running worker. The order is:
  1. Cancel (or let finish) every non-terminal workstream at `/workstreams`, **while the worker is still up**.
     Cancel goes through it.
  2. `systemctl disable --now mymind-worker` **first**. This drains it (≤ 60 s) and keeps it from
     starting again.
  3. **Before** deploying old code, if any workstream is still non-terminal (step 1 skipped, or a
     cancel did not land), clear it. Old code ignores the `workstreams` table but would claim its
     queued segments as plain turns the moment it starts:
     ```sql
     update agent_runs set status = 'aborted', finished_at = now(), error = 'rollback below cycle 81'
       where kind = 'workstream' and status in ('queued', 'running');
     update workstreams set state = 'cancelled', finished_at = now(), attention = null
       where state not in ('done', 'failed', 'cancelled');
     ```
  4. Then deploy the old commit (revert on `master` → CD, or the manual steps).
  Rolling forward again: a normal deploy of cycle ≥ 81. `provision-native.sh` re-enables the unit,
  and CD's activate and restart start it.

## 22. Sandboxed workspace (`mymind-sandbox`, cycle 82 — retired in cycle 86)

Cycle 82 ran each workspace in an unprivileged Docker container on LXC 114 (image `mymind-sandbox`,
the `mymind-sandbox` network, `MYMIND-SANDBOX-FWD`/`-IN` iptables chains, `mymind-sandbox-net.service`,
`/opt/mymind/.workspaces`, a Sandbox health CD step). **Cycle 86 deleted all of it**: `deploy/sandbox/`
no longer exists, `provision-native.sh` no longer builds or checks any of it, and CD has no Sandbox
health step. Workspaces are now directories on the Mac mini (`~/mymind/workspaces`); see
`docs/wiki/workspace.md` and §23.

**Leftovers on LXC 114.** Nothing deploys the old sandbox any more, but nothing removes it either. It
is harmless while LXC 114 is the rollback target (it only matters to the pre-cutover worker). At
**retirement** (cutover + 7 days, see the handover), remove it by hand: `systemctl disable --now
mymind-sandbox-net` and delete the unit and `/usr/local/lib/mymind`; delete the two iptables chains and
their `DOCKER-USER`/`INPUT` jumps; `docker network rm mymind-sandbox`; remove the `mymind-sandbox:*`
images and any `mymind.workspace`-labelled containers; `rm -rf /opt/mymind/.workspaces`.

## 23. Mac mini host (cycle 86)

Prod runs natively on the Mac mini (`bridget.local`, `192.168.2.35`, Apple M1 8 GB, macOS 15, user
`bridget`) with the DB on the homelab's central Postgres. LXC 114 stays as the **CI build box**.
Reference: the `prod-deploy` skill (ops), the spec
(`docs/superpowers/specs/2026-10-13-macmini-host-design.md`, with its option-C amendment) and the
handover (`docs/handovers/2026-10-13-macmini-host.md`).

```
Pangolin (public) ──> mini :3000   web     launchd com.mymind.web    (node .output/server/index.mjs)
                      mini         worker  launchd com.mymind.worker (dist/worker.mjs, AGENT_RUNTIME_EXCLUSIVE=1)
                      mini         BlueBubbles (untouched)           ← iMessage is now local
both ──> Postgres 192.168.2.80:5432 (db bridget, role bridget)       LiteLLM 192.168.2.85 / rig 192.168.2.25
LXC 114 (self-hosted runner on Proxmox) ── builds ── tar over ssh ──> mini
```

### launchd

Two LaunchAgents in `~/Library/LaunchAgents/` (the mini autologs in as `bridget`, so they start at
boot): `com.mymind.web` and `com.mymind.worker`. Templates are `deploy/macmini/com.mymind.{web,worker}.plist`
(`__HOME__` is substituted by `provision-macmini.sh`, then `plutil -lint`ed). Both run
`/bin/bash ~/mymind/bin/run.sh <web|worker>` with `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`,
`ProcessType Interactive`, and `ExitTimeOut` **20 s (web)** / **90 s (worker, so it can drain)**.
`run.sh` sources `~/mymind/env/mymind.env`, puts Homebrew on `PATH`, sets `NODE_ENV=production`,
`ulimit -n 10240` (launchd's default soft limit is 256), loads the release's `release.env` (the git sha
`/api/health` reports), runs from the **physical** release dir, writes
`~/Library/Logs/mymind/{web,worker}.log` (**size-rotated by the wrapper**, 50 MB x 5; no newsyslog and no
sudo), and `exec`s `node --max-old-space-size=1536` (web) or `=2048` (worker, which also gets
`AGENT_RUNTIME_EXCLUSIVE=1` and `MYMIND_EVALS_DIR=<release>/evals`). Only MyMind's own processes are
capped; Bridget's commands are not. The `*.launchd.log` files catch wrapper failures only.

### Release dirs and rollback

`deploy/macmini/release.sh` (installed at `~/mymind/bin/release.sh`) manages
`~/mymind/releases/{web,worker}-<sha>` and **symlink pointers**, each swapped with one `rename(2)`:

| Kind | current | previous | next |
|---|---|---|---|
| web | `~/mymind/app` | `.app-prev` | `.app-next` |
| worker | `~/mymind/.worker` | `.worker-prev` | `.worker-next` |

Commands: `stage <kind> <id>` (untar from stdin, then check the entry file, that every linux native
package has its `darwin-arm64` twin, that every darwin `*.node` actually `dlopen`s, and that the
worker's externals load with the mini's node; a bad release fails here, before any migration or restart),
`activate`, `rollback`, `restart` (waits for a **new** launchd pid; applies a pending plist change by
bootout, wait, install, bootstrap with retry on "Bootstrap failed: 5"), `health worker [s]`, `undo
<kind> <release>` (rollback + restart, only while current is exactly that release) and `status`.
Releases no pointer references are pruned on stage and activate. A running process keeps its old
release dir until restarted. Layout elsewhere under `~/mymind/`: `env/` (0700), `data/uploads`,
`workspaces`, `evals-scratch`, `deploy/`, `bin/`.

### CD: LXC 114 builds, the mini runs

`.github/workflows/deploy.yml`, deploy job, on `[self-hosted, proxmox]`. Two repo variables steer it:

- **`DEPLOY_TARGET`** (`lxc` | `macmini`; unset = `lxc`). A manual run's `target` input is
  `auto | lxc | macmini` (default `auto` = the variable). Every runtime step carries
  `if: env.DEPLOY_TARGET == '<target>'`.
- **`MYMIND_CUTOVER_DONE`** (`true` once prod runs on the mini). The first `[lxc]` step,
  *Refuse after cutover*, **fails** when `DEPLOY_TARGET` is `macmini` or `MYMIND_CUTOVER_DONE` is `true`,
  so a stray default run can never start LXC 114's retired units (a second worker re-running Tony's
  jobs and iMessages against the old database). A rollback to LXC 114 does **not** flip these (see Cutover
  and rollback); leave both set.

The `macmini` path: sync the checkout into LXC 114's **separate build dir `/opt/mymind-build`** (never
`/opt/mymind`, whose `.output` and `.worker` are the rollback target) → `provision-native.sh
--build-only` (fails if `mymind`/`mymind-worker` are still active in LXC 114) → `deploy/macmini/build-artifacts.sh`
(darwin-arm64 natives via `pnpm-workspace.yaml` `supportedArchitectures`; outputs `.macmini-out/{web,worker}`)
→ `prune-arch.sh` (called by `build-artifacts.sh`: drops `linux-arm64`, `darwin-x64` and `linuxmusl` native dirs, then fails the build if linux-x64 or darwin-arm64 `*.node` binaries are gone; `build-artifacts.sh` itself refuses to run in `/opt/mymind`, the `MYMIND_LXC_RUNTIME_DIR` default, symlinks resolved)
→ provision the mini (`provision-macmini.sh`, idempotent) → `release.sh stage` both releases over
`tar | ssh` (the mini's rsync is Apple's openrsync) → cancel running evals and `pnpm db:migrate` from
LXC 114 against `.80` using `/opt/mymind-build/.env.macmini` → activate + restart the web and gate on
`/api/health` over the LAN IP **reporting the new git sha** → activate + restart the worker and gate on a
heartbeat from the **new** pid (started after the restart, < 30 s old) → a final
`if: (failure() || cancelled())` step runs `release.sh undo` for worker then web (only releases this run
activated). The `macmini` path never restarts LXC 114's units.

### Central DB

`192.168.2.80:5432`, database `bridget`, role `bridget` (owner; PG 17.6; `vector`, `pgcrypto`,
`pg_trgm`, `ltree` pre-installed by the homelab). The URL lives only in `~/mymind/env/mymind.env`
(`DATABASE_URL` **and** `NUXT_DATABASE_URL`, mode 0600) and in `/opt/mymind-build/.env.macmini` on LXC
114 (same two keys, for CD's migrate and `pnpm eval --cancel-all`). Never write the password in docs,
commits or CI logs. **Backups of `.80` are the homelab's responsibility** (Tony confirms); the mini
backs up nothing for the DB.

### Production platform guard

The host runtime runs Bridget's commands unconfined as the worker's user. In production the manager
refuses every non-eval workspace command unless the platform is `darwin` or
`MYMIND_HOST_RUNTIME_ALLOWED=1` is set. **Do not set the override on LXC 114.** It exists so a
deliberately handed-over Linux host can opt in. Merging to `master` while CD still targets `lxc` would
otherwise put an unconfined root shell on the box that holds Docker and the old database; this guard
(plus the *Refuse after cutover* step) is why that ordering mistake is survivable.

### One-time setup (Tony)

1. **Runner SSH key.** On the Proxmox host: `ssh-keygen -t ed25519 -N "" -C mymind-cd -f /root/.ssh/mymind_macmini`;
   append the `.pub` to `/Users/bridget/.ssh/authorized_keys` on the mini; `ssh-keyscan -t ed25519
   192.168.2.35 >> /root/.ssh/known_hosts` (CD uses `StrictHostKeyChecking=yes`); verify with
   `ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes bridget@192.168.2.35 hostname`.
2. **`~/mymind/env/mymind.env`** on the mini (0600 in a 0700 dir; `KEY=value` lines **sourced by bash**,
   so quote values with spaces, `$`, `#` or quotes). Keys: see `.env.example` (Mac mini section) and
   the skill. Copy `BETTER_AUTH_SECRET` (and `CONFIG_ENC_KEY` if set) from LXC 114 **unchanged**: provider
   keys in the DB are encrypted with a key derived from them. Every runtimeConfig key needs its `NUXT_`
   twin. `provision-macmini.sh --check` enforces this with `check-env-twins.sh`, driven by
   `deploy/macmini/runtime-env-twins.txt` (plain -> twin pairs, derived from core's config mapper and
   `nuxt.config.ts` and drift-tested by `test/macmini-env-twins.test.ts`); it prints key names only, and a
   missing twin is a FAIL.
3. **`gh auth login` as Patrity** on the mini (as `bridget`), full access (accepted risk on a
   dedicated box). Her `git`/`ssh` logins live in her macOS account.
4. `/opt/mymind-build/.env.macmini` in LXC 114 (see Central DB).

### Cutover and rollback

The ordered runbook is **`deploy/macmini/CUTOVER.md`** (window of **30 to 60 minutes**: stop LXC units,
`pg_dump`, `pg_restore` into `.80` with `compare-counts.sh`, `copy-uploads.sh`, set `DEPLOY_TARGET` and
`MYMIND_CUTOVER_DONE`, merge, CD, Pangolin); the handover summarises it.

**Rollback** within the 7-day window needs **no workflow run**, because macmini deploys build in
`/opt/mymind-build` and never write `/opt/mymind`: `launchctl bootout` the mini's worker then web; in LXC
114 `docker compose up -d db` and `systemctl enable --now mymind mymind-worker` (cycle-85 code, old
database); point Pangolin back at LXC 114. **`DEPLOY_TARGET` stays
`macmini`** (and `MYMIND_CUTOVER_DONE` stays set): a push then fails harmlessly at `--build-only`, whereas
switching to `lxc` would build new code onto the old database. Rows written on `.80` after cutover are not
in the old database.

Files: `deploy/macmini/{CUTOVER.md,provision-macmini.sh,release.sh,run.sh,build-artifacts.sh,prune-arch.sh,check-env-twins.sh,runtime-env-twins.txt,compare-counts.sh,copy-uploads.sh,com.mymind.web.plist,com.mymind.worker.plist}`.
