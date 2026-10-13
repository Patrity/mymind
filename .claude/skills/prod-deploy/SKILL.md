---
name: prod-deploy
description: Use when interacting with the MyMind PRODUCTION deployment — checking web or agent-worker health/logs, restarting the services, inspecting/editing prod env, running DB ops against prod, running or cancelling evals, diagnosing a bad deploy, or rolling back. Since cycle 86 prod runs natively on the Mac mini (user bridget @ 192.168.2.35, launchd agents com.mymind.web + com.mymind.worker) against the central Postgres at 192.168.2.80; Proxmox LXC 114 is only the CI build box (DEPLOY_TARGET=lxc keeps the old in-LXC runtime until cutover). Covers access, common ops, CD, one-time setup, and the gotchas that have caused incidents.
---

# Prod deployment ops (Mac mini + LXC 114 build box)

| Thing | Where |
|---|---|
| Web | launchd agent `com.mymind.web` (user `bridget`), `node --max-old-space-size=1536 ~/mymind/app/.output/server/index.mjs`, `0.0.0.0:3000` |
| Agent worker | launchd agent `com.mymind.worker`, `node --max-old-space-size=2048 ~/mymind/.worker/dist/worker.mjs`, `AGENT_RUNTIME_EXCLUSIVE=1` — the ONLY executor of agent runs; talks to the web only via Postgres |
| Wrapper | `~/mymind/bin/run.sh web\|worker` (sources the env file, Homebrew PATH, heap cap, log, then `exec node`) |
| Releases | `~/mymind/releases/{web,worker}-<sha>`; symlink pointers `app` / `.app-prev` / `.app-next` and `.worker` / `.worker-prev` / `.worker-next` — `~/mymind/bin/release.sh stage\|activate\|rollback\|restart\|health\|status` |
| Env | `~/mymind/env/mymind.env` (0600, hand-written, never committed — see [Env file](#env-file)) |
| Data | uploads `~/mymind/data/uploads`, workspaces `~/mymind/workspaces`, eval worlds `~/mymind/evals-scratch` |
| Logs | `~/Library/Logs/mymind/{web,worker}.log` (size-rotated by run.sh: 50 MB × 5), `*.launchd.log` (wrapper failures only) |
| Postgres | central `192.168.2.80:5432`, db + role `bridget` (not superuser; extensions pre-installed) |
| Neighbours on the mini — **never touch** | BlueBubbles (app + `app.bluebubbles.server` agent, the iMessage channel), `node_exporter` (brew services) |
| Build box | LXC 114 (`/opt/mymind`) on the Proxmox host 192.168.2.50; the self-hosted runner (root on the host) drives it with `pct exec 114` |
| Public URL | `https://brain.costanzoclan.com` (Pangolin → `192.168.2.35:3000`) |
| CD | `.github/workflows/deploy.yml`, target from the repo variable `DEPLOY_TARGET` (`lxc` \| `macmini`) |

Spec: `docs/superpowers/specs/2026-10-13-macmini-host-design.md` (§5 deploy, §6 cutover runbook).

## Access

```bash
ssh bridget@192.168.2.35 '<command>'
```
- **A non-login ssh command has no Homebrew on PATH** (`node`, `rg`, `psql` "not found"). Use absolute
  paths (`/opt/homebrew/bin/node`, `/opt/homebrew/opt/libpq/bin/psql`) or `zsh -lc '…'`.
- The services live in bridget's **GUI** launchd domain: `gui/$(id -u)` (uid 501). They exist only while
  bridget is logged in — the mini autologs in after a reboot (`provision-macmini.sh --check` verifies it).

SQL against prod without ever printing the URL (it is read from the env file on the mini):
```bash
minisql() { local b; b=$(printf '%s' "$1" | base64); ssh bridget@192.168.2.35 \
  "set -a; . ~/mymind/env/mymind.env; set +a; echo $b | base64 -d | /opt/homebrew/opt/libpq/bin/psql \"\$DATABASE_URL\" -X"; }
minisql 'select count(*) from documents;'
```

**LXC 114 (build box)** — only through the Proxmox host. Quote the WHOLE remote command: `ssh` joins its
arguments, so an unquoted `;`/`&&` runs the rest **on the Proxmox host**, and without one `bash -lc`
gets only the first word (both exit 0 — this has produced a confident, wrong "prod is wiped" report).
Pipe base64 for anything with nested quotes; check `hostname` (expect `mymind`) when a result surprises you:
```bash
lxc() { local b; b=$(printf '%s' "$1" | base64); ssh root@192.168.2.50 "pct exec 114 -- bash -lc 'echo $b | base64 -d | bash'"; }
lxc 'hostname'
```
Keys: `~/.ssh/claude-code` is mapped for `root@192.168.2.50` (alias `mini` in `~/.ssh/config` = the
**Proxmox host**, not the Mac mini — mind the name).

## Common ops (Mac mini)

```bash
# Services
ssh bridget@192.168.2.35 'launchctl print gui/501/com.mymind.web | grep -E "state|pid|last exit"'
ssh bridget@192.168.2.35 'launchctl print gui/501/com.mymind.worker | grep -E "state|pid|last exit"'
ssh bridget@192.168.2.35 'bash ~/mymind/bin/release.sh status'           # which release each pointer holds

# Logs
ssh bridget@192.168.2.35 'tail -n 120 ~/Library/Logs/mymind/web.log'
ssh bridget@192.168.2.35 'tail -f ~/Library/Logs/mymind/worker.log'
ssh bridget@192.168.2.35 'grep -iE "error|unhandled|ECONNREFUSED" ~/Library/Logs/mymind/web.log | tail -40'
ssh bridget@192.168.2.35 'cat ~/Library/Logs/mymind/*.launchd.log'      # wrapper failures (env/release missing)

# Restart = SIGTERM (the worker drains in-flight runs ≤ 60 s; ExitTimeOut 90), launchd restarts it
ssh bridget@192.168.2.35 'bash ~/mymind/bin/release.sh restart web'
ssh bridget@192.168.2.35 'bash ~/mymind/bin/release.sh restart worker'

# Health — /api/health runs `select 1` (proves the DB); /login is SSR-only and proves nothing
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.2.35:3000/api/health      # LAN (proves the 0.0.0.0 bind)
curl -s -o /dev/null -w "%{http_code}\n" https://brain.costanzoclan.com/api/health # through Pangolin
ssh bridget@192.168.2.35 'bash ~/mymind/bin/release.sh health worker 30'          # launchd pid has a fresh heartbeat

# Env — key NAMES only, or masked
ssh bridget@192.168.2.35 'cut -d= -f1 ~/mymind/env/mymind.env'
ssh bridget@192.168.2.35 "sed -E 's#://[^@]*@#://***@#; s#(SECRET|KEY|TOKEN|PASSWORD)([A-Z_]*)=.*#\1\2=***#' ~/mymind/env/mymind.env"

# Worker heartbeat / trapped crashes
minisql 'select boot_id, pid, host, started_at, now()-beat_at as age from worker_heartbeat order by beat_at desc limit 3;'
minisql "select created_at, name, error->>'message' from activity_log where name like 'worker:%' order by created_at desc limit 10;"

# Disk (workspace work pauses under 5 GB free, resumes at 8 GB) + release sizes
ssh bridget@192.168.2.35 'df -h ~; du -sh ~/mymind/releases/* ~/mymind/workspaces ~/mymind/evals-scratch 2>/dev/null'

# Provisioning state, read-only (CD runs the same script in apply mode every deploy)
ssh bridget@192.168.2.35 'bash ~/mymind/deploy/provision-macmini.sh --check'
```

Workspace commands run **unconfined on the host as bridget** (cycle 86 option C — her Homebrew tools
and CLI logins just work); only eval worlds run under `sandbox-exec` (offline, scratch dir). See
`docs/wiki/workspace.md`.

### "There are errors in prod" — AI/provider errors are in `activity_log`, NOT the logs

The logs carry request-level `[request error]` lines and job progress. Every AI call is recorded by
`withFailoverOver` into `activity_log` (kind `attempt` per model, `name = <usage>:<model label>`, plus
`<usage>:all-failed`) — what the Activity page shows:
```bash
minisql "select usage, provider, name, status, count(*), min(created_at), max(created_at) from activity_log where (status='error' or severity in ('error','warn')) and created_at > now() - interval '7 days' group by 1,2,3,4 order by max(created_at) desc limit 40;"
minisql "select created_at, name, attempt, duration_ms, left(error->>'message',300) from activity_log where usage='tts' and status='error' order by created_at desc limit 20;"
```
Read the **attempt pattern**: `attempt=0 error` then `attempt=1 ok` ms apart on every call = the chain
head is wrong for the request (failover masking a routing bug), not an outage. Errors on a 5-min cadence
with `5xx`/`fetch failed` are upstream (LiteLLM `192.168.2.85:4000`, the rig `192.168.2.25`) — curl it
from the mini before touching code.

### Evals on prod (`docs/wiki/eval.md`)

Each eval world is a temporary schema (`eval_<run>_<suffix>`) on the prod DB plus a scratch dir under
`~/mymind/evals-scratch`. They share model/judge/connection capacity with Tony's runs: run one only when
Tony is idle, **never during a deploy** (CD cancels them before migrating). `eval.concurrency` (default 1)
and `eval.maxTokensPerRun` bound one run.

The eval CLI needs the workspace (`pnpm`, `tsx`), so it runs **from LXC 114** with `/opt/mymind/.env.macmini`:
```bash
lxc 'cd /opt/mymind && set -a && . ./.env.macmini && set +a && NODE_ENV=production pnpm eval bridget-core --case <slug> --n 1'
lxc 'cd /opt/mymind && set -a && . ./.env.macmini && set +a && NODE_ENV=production pnpm eval --cancel-all --wait 60'
lxc 'cd /opt/mymind && set -a && . ./.env.macmini && set +a && NODE_ENV=production pnpm eval --cancel <runId>'
```
> **The eval CLI `.env` gotcha.** `pnpm eval` starts node with `--env-file-if-exists=.env`, which fills
> every key NOT already in the environment from LXC 114's `.env` — the old Docker-era DB
> (`…@db:5432/mymind`). And core prefers `NUXT_DATABASE_URL` over `DATABASE_URL` (`NITRO_DATABASE_URL`
> beats both — never set it). So `.env.macmini` must
> set **both** `DATABASE_URL` and `NUXT_DATABASE_URL` (→ `.80`), exported before the CLI starts; source
> `.env.native` instead (or forget the NUXT_ twin) and the command silently talks to LXC 114's old
> database. `NODE_ENV=production` also makes `--local` refuse (runs must go through the mini's worker).

Leftover worlds (should be empty when no eval runs; the worker's sweeps drop ghosts within ~2 h):
```bash
minisql "select nspname from pg_namespace where nspname like 'eval\_%';"
minisql "select id, suite_id, status, alive_at, error from eval_runs where status in ('queued','running');"
ssh bridget@192.168.2.35 'ls ~/mymind/evals-scratch'
```

## Deploy & rollback

**Deploy = push to `master`.** The `deploy` job's target is `${{ inputs.target || vars.DEPLOY_TARGET || 'lxc' }}`
(a manual `workflow_dispatch` defaults to `auto` = the variable; only an explicit `lxc`/`macmini` overrides
it). Flip at cutover: `gh variable set DEPLOY_TARGET --body macmini` and `gh variable set MYMIND_CUTOVER_DONE --body true`
— from then on the `[lxc] Refuse after cutover` step fails any lxc run, so nothing restarts the retired
LXC 114 units by accident.

`macmini` (every step `[macmini]`):
1. Reach the mini → `provision-native.sh --build-only` in LXC 114 (Node/pnpm, `.env.macmini` check;
   FAILS while the old LXC units still run).
2. `deploy/macmini/build-artifacts.sh` in LXC 114: `pnpm install` (clean when the darwin-arm64 natives are
   missing), build (`--max-old-space-size=4096`), worker bundle + stage → `.macmini-out/{web,worker}`
   (both get `release.env` with the sha, the worker `evals/`; linux-arm64/darwin-x64 natives are dropped).
3. Ship `deploy/macmini/` to `~/mymind/deploy/` and run `provision-macmini.sh` (dirs, ripgrep/libpq,
   `~/mymind/bin/{run,release}.sh`, plists via `plutil -lint`, env key check, Hermes guard). It NEVER
   reloads a running agent: a changed plist waits in `~/mymind/deploy/agents/` and `release.sh restart`
   applies it inside the gated step (bootout → wait for the exit → install → bootstrap, retried on
   `Bootstrap failed: 5`).
4. Stream each release as tar → `release.sh stage <kind> <sha>`: entry file, every linux native has its
   darwin-arm64 twin, every darwin `*.node` dlopens, externals/sharp load with the mini's node. **The running services are untouched.**
5. In LXC 114 with `.env.macmini`: `pnpm eval --cancel-all --wait 60` (never fails the deploy) →
   `pnpm db:migrate` against `.80`.
6. `release.sh activate web && release.sh restart web` (returns only once launchd runs a NEW pid) →
   `curl http://192.168.2.35:3000/api/health` from the runner until it reports `"sha":"<this commit>"`
   (30 × 5 s; `sha` = `MYMIND_GIT_SHA` from the release's `release.env`).
7. `release.sh activate worker && release.sh restart worker` → `release.sh health worker 120`: launchd's
   pid differs from the one replaced, and has a heartbeat row started after the restart, on this host,
   beating < 30 s ago.
8. **Any failure** → the last step `[macmini] Roll back web + worker on failure` runs `release.sh undo` for
   both kinds — web and worker go back **together** (no version skew), but only a release this run
   activated (undo is a no-op unless current is exactly the release this run staged).

`lxc` (the pre-cutover path, steps `[lxc]`): sync → `docker compose up -d db` → `provision-native.sh` →
install/build/`worker-release.sh stage` → cancel evals + migrate (`.env.native`) → `systemctl restart
mymind` → health → `worker-release.sh activate` + `systemctl restart mymind-worker` → heartbeat.

- Watch: `gh run watch <id> --exit-status` — **never pipe it to `tail`** (masks a failed deploy).
- **Rollback (mini)**, one level, any time — both kinds together, as CD does: `ssh bridget@192.168.2.35 'for k in worker web; do bash ~/mymind/bin/release.sh rollback $k && bash ~/mymind/bin/release.sh restart $k; done'`. Rolling back only one kind leaves web and worker on different commits (they share the DB and the bus — avoid unless you know the pair is compatible). Migrations are never reverted — a rollback across a migration needs the old code to tolerate the new schema; otherwise revert on `master` and push.
- **Back to LXC 114** (first 7 days after cutover, while its DB + data are kept): stop both launchd agents
  (`launchctl bootout gui/501/com.mymind.web` / `…worker`), `systemctl enable --now mymind mymind-worker`
  in LXC 114, Pangolin back to the LXC IP, `gh variable set DEPLOY_TARGET --body lxc`, `gh variable delete MYMIND_CUTOVER_DONE`. Data written on
  `.80` meanwhile is NOT in the LXC DB.

### When CD never fires (manual deploy)

First prove no run was created: `gh api "repos/Patrity/mymind/actions/runs?head_sha=$(git rev-parse HEAD)" --jq .total_count`
→ `0`. Rule out `paths-ignore` (docs/`.md`-only push), `[skip ci]`, Actions disabled, runner offline
(`gh api repos/Patrity/mymind/actions/runners`), then **GitHub's status** (2026-08-06: Actions throttled
webhooks to ~15% while Git stayed green):
```bash
curl -s https://www.githubstatus.com/api/v2/components.json | python3 -c "import sys,json;[print(c['name'],c['status']) for c in json.load(sys.stdin)['components'] if c['name'] in ('Actions','Webhooks','Git Operations')]"
```
Then trigger it by hand — `gh workflow run deploy.yml --ref master -f target=macmini` — or, if Actions
itself is down, replay the `[macmini]` steps from the Proxmox host (run the full local gates on that
exact commit first; you are skipping the `test` job). Ship the tree with `git archive` so local scratch
never reaches prod:
```bash
git archive --format=tar HEAD | ssh root@192.168.2.50 "pct exec 114 -- tar -C /opt/mymind -xf -"
# then, ON the Proxmox host (it holds the runner's mini key): the deploy.yml [macmini] run blocks in order,
# with MINI=bridget@192.168.2.35 MINI_SSH="ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes"
```
Prove the NEW code is live — a restart plus a 200 doesn't: `release.sh status` shows the sha, and grep
the running bundle for a symbol new in this commit:
`ssh bridget@192.168.2.35 'grep -rl "<symbol>" ~/mymind/app/.output/server/ | head -3'`. Best authed
canary: any `mcp__mymind__*` call (they point at PROD).

## One-time setup

### Runner SSH key (Proxmox host → bridget@mini)
The runner is root on the Proxmox host. CD uses `/root/.ssh/mymind_macmini` with the mini's host key
pinned (`StrictHostKeyChecking=yes`):
```bash
ssh root@192.168.2.50 'ssh-keygen -t ed25519 -N "" -C mymind-cd -f /root/.ssh/mymind_macmini && cat /root/.ssh/mymind_macmini.pub'
# append that ONE line to /Users/bridget/.ssh/authorized_keys on the mini (Tony, or ssh bridget@… from his Mac)
ssh root@192.168.2.50 'ssh-keyscan -t ed25519 192.168.2.35 >> /root/.ssh/known_hosts'
ssh root@192.168.2.50 'ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes bridget@192.168.2.35 hostname'   # expect bridget.local
```

### Env file
`~/mymind/env/mymind.env` on the mini — `KEY=value` lines **sourced by bash** (quote values with spaces,
`$`, `#` or quotes; systemd's EnvironmentFile syntax from LXC 114 is not always shell-safe). Mode 0600 in
a 0700 dir. Required (provision checks the names, the `.80` host, `0.0.0.0`, `3000`, the uploads path):
`DATABASE_URL` + `NUXT_DATABASE_URL` (→ `192.168.2.80:5432/bridget`), `BETTER_AUTH_SECRET` +
`NUXT_BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` + `NUXT_BETTER_AUTH_URL` (`https://brain.costanzoclan.com`),
`STORAGE_LOCAL_DIR` + `NUXT_STORAGE_LOCAL_DIR` (`/Users/bridget/mymind/data/uploads`), `NITRO_HOST=0.0.0.0`,
`NITRO_PORT=3000`; plus whatever else prod set (`CONFIG_ENC_KEY`, `NUXT_GOOGLE_*`, …) with NUXT_ twins.
**Copy `BETTER_AUTH_SECRET` (and `CONFIG_ENC_KEY` if set) from LXC 114 unchanged** — provider API keys in
the DB are encrypted with a key derived from them, and every session is signed with it.

`/opt/mymind/.env.macmini` in LXC 114 (0600): `DATABASE_URL` + `NUXT_DATABASE_URL` → `.80` (both — see the
eval gotcha). Preserved by CD's sync.

### Log rotation
None to set up: `run.sh` rotates `{web,worker}.log` itself (launchd's StandardOutPath can't be rotated
under a running process, and system newsyslog would need sudo).

## Gotchas that have bitten us

1. **`NUXT_DATABASE_URL`, not just `DATABASE_URL`.** The web's `useRuntimeConfig()` is **baked at build**
   (in LXC 114, from its `.env` = the old `@db:5432`); at runtime only `NUXT_*` vars override it. Every
   runtimeConfig key needs its NUXT_ twin in `mymind.env`, or the web dials the build-baked value while
   migrations (plain `DATABASE_URL`) succeed — a green deploy with a broken app.
2. **Symptom:** `/login` 200 but every authed call (`/api/mcp`, `/api/hooks/cc/*`) 500. Always health-check
   a DB-touching endpoint.
3. **`NITRO_HOST=0.0.0.0`.** Pangolin reaches the mini by IP; a loopback bind passes a local curl and 502s
   externally. CD's web gate curls the LAN IP for this reason.
4. **The mymind MCP + Claude Code hooks point at PROD** — a useful canary when prod is down.
5. **Cross-arch native binaries.** LXC 114 is linux/x64, the mini darwin/arm64. `pnpm-workspace.yaml`
   `supportedArchitectures` installs the darwin-arm64 `@img/sharp-*` and `@napi-rs/canvas-*` too; pnpm
   says "Already up to date" when only that setting changed, so `build-artifacts.sh` wipes a node_modules
   without the darwin sharp. `release.sh stage` refuses a release with a linux native lacking its twin.
6. **`launchctl kickstart -k` sends SIGTERM** (then SIGKILL after the plist's `ExitTimeOut`: web 20 s,
   worker 90 s) — the worker's drain works as it did under systemd.
7. **Non-login ssh has no Homebrew PATH**; launchd neither — `run.sh` sets it for the services (agent
   commands get their own Homebrew-first PATH from `hostBaseEnv`, or `WORKSPACE_PATH`).
8. **The services need bridget's GUI session**: autologin on, sleep off (`pmset -g`: `sleep 0`). A
   reboot with autologin broken leaves MyMind down while ssh still works.
9. **Hermes is retired** — `provision-macmini.sh` fails if any hermes launchd job is loaded or `:3000` is
   held by anything but `com.mymind.web`.

## Don't

- Don't print unmasked env files or `DATABASE_URL`; never `bash -x` anything that sources an env file.
- Don't touch BlueBubbles or node_exporter on the mini.
- Don't restart/migrate casually during active use without flagging it.
- Don't assume `/login` 200 means healthy — use `/api/health`.
- Don't run `pnpm eval` from LXC 114 with `.env.native` after cutover — that is the old database.
