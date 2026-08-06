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

> ⚠️ **The single most dangerous mistake in this file — read before running anything.**
> `ssh` joins **all** of its arguments into one command string, so your local shell's quotes are
> stripped before the remote shell ever parses them. `bash -lc` then receives only the **first
> word** as its script; the rest become positional parameters (`$0`, `$1`, …). This fails two
> different ways, both silent and both exit 0:
>
> | Your command contains | What actually happens |
> |---|---|
> | an unquoted `;` or `&&` | the remote shell splits there — everything after the separator runs **on the Proxmox host**, not in the container |
> | no separator | runs in the container, but as bare `<firstword>` with every other token discarded into `$@` (e.g. `systemctl status mymind` → plain `systemctl`, `docker exec … psql …` → plain `docker` usage) |
>
> ```bash
> # ✗ BROKEN — prints a blank line, then "mini" (the HOST)
> ssh root@192.168.2.50 -- pct exec 114 -- bash -lc 'echo hi; hostname'
>
> # ✓ CORRECT — prints "hi", then "mymind" (LXC 114)
> ssh root@192.168.2.50 "pct exec 114 -- bash -lc 'echo hi; hostname'"
> ```
>
> This has already burned a session: it made an intact prod look like a wiped container
> (`/opt/mymind` "missing", `mymind` "inactive", `docker` "not found" — all true of the host,
> none true of the LXC) and produced a confident, wrong "prod has moved" report. A
> `systemctl restart …` or `docker exec … psql` typed the broken way silently targets the
> **wrong machine or the wrong command**.
> **Always verify with `hostname` when a result surprises you.**

**Use these two forms.** Quote the entire remote command; never rely on an unquoted `--` chain:

```bash
# Proxmox host
ssh root@192.168.2.50 '<host command>'

# Anything INSIDE LXC 114 (the app) — note the outer double quotes
ssh root@192.168.2.50 "pct exec 114 -- bash -lc '<command run in the LXC>'"
```

For anything with nested quotes, SQL, or `$`-expansion, skip quoting entirely and pipe base64 —
this is the reliable form for DB work:

```bash
lxc() { local b=$(printf '%s' "$1" | base64); \
  ssh root@192.168.2.50 "pct exec 114 -- bash -lc 'echo $b | base64 -d | bash'"; }

lxc 'systemctl status mymind --no-pager'
lxc 'docker exec -i mymind-db psql -U mymind -d mymind -c "select count(*) from documents;"'
```

**SSH keys:** the authorized key is `~/.ssh/claude-code`. `~/.ssh/config` maps it for both the
alias (`mini`) and the literal IP (`192.168.2.50`), so either host form works. If you get
`Permission denied (publickey)`, the IP's config block has lost its `IdentityFile` line — add
`IdentityFile ~/.ssh/claude-code` back, or fall back to `ssh mini`.

Run read-only checks freely. For anything that restarts the service or edits env/DB, prefer to
say what you're about to do first — a restart is a few seconds of downtime.

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

Define the `lxc` helper from the Access section first — it base64-pipes the script, so nested
quotes, `;`, `&&`, `$(…)`, and SQL all survive intact:

```bash
lxc() { local b=$(printf '%s' "$1" | base64); \
  ssh root@192.168.2.50 "pct exec 114 -- bash -lc 'echo $b | base64 -d | bash'"; }

# Sanity-check you're actually in the container before trusting anything below
lxc 'hostname'                                    # expect "mymind", NOT "mini"

# App status / logs
lxc 'systemctl status mymind --no-pager'
lxc 'journalctl -u mymind -n 120 --no-pager'
lxc 'journalctl -u mymind -f'                     # live tail
lxc 'journalctl -u mymind --since "10 min ago" --no-pager | grep -iE "error|unhandled|ECONNREFUSED"'

# Restart (a few seconds of downtime)
lxc 'systemctl restart mymind && sleep 4 && systemctl is-active mymind'

# Health — /api/health does `select 1` (proves DB). /login is SSR-only and does NOT prove DB.
lxc 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health'   # expect 200

# Containers (should be ONLY mymind-db + mymind-searxng)
lxc 'docker ps'

# Inspect env WITHOUT leaking secrets (mask user:pass)
lxc 'sed -E "s#://[^@]*@#://***@#" /opt/mymind/.env.native'

# What env the RUNNING process actually has (the source of truth)
lxc 'pid=$(systemctl show -p MainPID --value mymind); tr "\0" "\n" < /proc/$pid/environ | grep -E "^(NUXT_DATABASE_URL|DATABASE_URL|NITRO_HOST|NODE_ENV)=" | sed -E "s#://[^@]*@#://***@#"'

# Postgres (no host port exposed beyond loopback; go via the container)
lxc 'docker exec -i mymind-db psql -U mymind -d mymind -c "select count(*) from documents;"'
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

### When CD never fires (manual deploy)

**First confirm the push actually failed to trigger, rather than guessing.** A push can land with
zero workflow runs created — `git ls-remote origin master` shows your SHA, but
`gh api "repos/Patrity/mymind/actions/runs?head_sha=$(git rev-parse HEAD)" --jq .total_count`
returns `0`. Rule out the cheap causes first (all checkable):
`paths-ignore` (the push must contain a non-`docs/`, non-`.md` file), a `[skip ci]` directive in any
pushed commit message, `gh api repos/Patrity/mymind/actions/permissions` → `enabled`, and
`gh api repos/Patrity/mymind/actions/runners` → runner `online`. If those are all clean, check
**GitHub's own status** — this is the one that has actually bitten us:

```bash
curl -s https://www.githubstatus.com/api/v2/components.json | \
  python3 -c "import sys,json;[print(c['name'],c['status']) for c in json.load(sys.stdin)['components'] if c['name'] in ('Actions','Webhooks','Git Operations')]"
curl -s https://www.githubstatus.com/api/v2/incidents/unresolved.json | head -c 2000
```

**2026-08-06:** Actions was in a `major_outage` throttling webhooks to ~15%, so pushes simply did
not create runs while Git Operations stayed green. Symptom is exactly the above: push succeeds,
`PushEvent` registers in `repos/.../events`, no run exists. Nothing is wrong with the repo.

To deploy anyway, replicate `deploy.yml`'s steps over `pct exec`. Define the `lxc` helper from the
Access section first. **Run the full local gates (`pnpm typecheck && pnpm test && pnpm build`) on the
exact commit you are deploying** — you are skipping the CI `test` job that normally gates `deploy`.

```bash
# 1. clear the tracked tree, preserving runtime state
lxc 'cd /opt/mymind && find . -maxdepth 1 -mindepth 1 ! -name .git ! -name .env ! -name .env.native \
  ! -name .data ! -name .output ! -name .nuxt ! -name node_modules ! -name workspace -exec rm -rf {} +'

# 2. sync — `git archive` beats `tar` here: it ships EXACTLY the tracked tree at HEAD,
#    so local gitignored scratch (.superpowers/, .claude/worktrees/) cannot leak into prod
git archive --format=tar HEAD | ssh root@192.168.2.50 "pct exec 114 -- tar -C /opt/mymind -xf -"

# 3-5. same as CD; the OLD app keeps serving until the restart in step 6
lxc 'cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d db searxng'
lxc 'cd /opt/mymind && bash deploy/provision-native.sh'
lxc 'cd /opt/mymind && pnpm install --frozen-lockfile'
lxc 'cd /opt/mymind && NODE_OPTIONS=--max-old-space-size=4096 NUXT_PUBLIC_UNMUTE_URL="" pnpm build'
lxc 'cd /opt/mymind && set -a && . ./.env.native && set +a && pnpm db:migrate'

# 6. cutover (the only downtime) + health
lxc 'cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d --remove-orphans db searxng && systemctl restart mymind'
lxc 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health'   # expect 200
```

**Then prove the NEW code is live — a restart plus a 200 does not prove the build changed.** Grep the
running bundle for a symbol unique to what you shipped, and check the authed path separately:

```bash
lxc 'ls -la --time-style=+%Y-%m-%dT%H:%M /opt/mymind/.output/server/index.mjs'   # fresh timestamp
lxc 'grep -rl "<symbol-new-in-this-cycle>" /opt/mymind/.output/server/ | head -3'
lxc 'journalctl -u mymind --since "3 min ago" --no-pager | grep -icE "error|unhandled|ECONNREFUSED"'
curl -s -o /dev/null -w "%{http_code}\n" https://brain.costanzoclan.com/api/health   # external path
```

Best authed canary: call any `mcp__mymind__*` tool — they point at PROD, so a successful round-trip
proves auth + DB end-to-end (gotcha #2), which `/login` cannot.

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
