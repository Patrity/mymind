# Cutover: LXC 114 to the Mac mini (cycle 86)

The one-time move of prod MyMind:

- **from** LXC 114 (systemd units `mymind` and `mymind-worker`, plus the Docker Postgres `mymind-db`)
- **to** the Mac mini (`bridget@192.168.2.35`, LaunchAgents `com.mymind.web` and `com.mymind.worker`)
- **with the database on** the central Postgres at `192.168.2.80:5432/bridget`.

This file contains no secrets. Env files and variables are named here, never their values. Never run
`bash -x` on anything that sources an env file, and never `cat` one. Day-to-day ops live in the
`prod-deploy` skill (`.claude/skills/prod-deploy/SKILL.md`).

**Where commands run:**

| Shorthand | Meaning |
|---|---|
| **PVE** | root on the Proxmox host, `ssh root@192.168.2.50` |
| **LXC** | a root shell inside the container: `pct enter 114` from PVE. Paste the blocks as they are; several contain single quotes, so they do not survive being wrapped in `pct exec 114 -- bash -lc '…'`. Keep ONE `pct enter` session for W2–W4, because `$DUMP` lives in it. |
| **MINI** | `ssh bridget@192.168.2.35` |
| **GH** | Tony's Mac with `gh` |

## Window: plan 30–60 minutes of downtime

Prod is dark from step W1 (the units stop) until step W9 (Pangolin points at the mini). The time goes to:

| Step | Rough time |
|---|---|
| Dump the old DB | 2–5 min |
| Restore into `.80` and rebuild the HNSW indexes | 5–20 min |
| Row-count compare | ~1 min |
| Copy the uploads (~69 MB) | ~1 min |
| The CD run | 15–25 min |
| Smoke tests | 5–10 min |

**Why the restore is slow.** The restore rebuilds every index. `messages_embedding_hnsw` alone was 563 MB over about 265k rows. `chunks_embedding_hnsw` (45 MB) and `memories_embedding_hnsw` (24 MB) come on top.

**What the CD run spends its time on:**

- the full `test` job on ubuntu;
- the first `pnpm install` in the fresh `/opt/mymind-build` (a clean cross-arch install);
- the Nuxt build with a 4 GB heap, and the worker build;
- a ~711 MB tar to the mini;
- the dlopen staging checks and both health gates.

**Nothing can be built ahead of time through CD.** A macmini run fails at `provision-native.sh --build-only` while the LXC units still run. This is deliberate.

**One optional pre-warm.** It is safe while LXC still serves, because it only touches `/opt/mymind-build`. Before the window, copy the branch into `/opt/mymind-build` and run `pnpm install --frozen-lockfile` there. The CD run's install is then incremental. Do NOT run `build-artifacts.sh` or anything else in `/opt/mymind`.

## Before the window (any time)

- [ ] **P1. Runner SSH key.** Follow the `prod-deploy` skill, section "Runner SSH key": key `/root/.ssh/mymind_macmini` on PVE, its public half in the mini's `authorized_keys`, the host key pinned in PVE's `known_hosts`. Then verify from PVE:
  ```
  ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes bridget@192.168.2.35 hostname
  ```
  It must print `bridget.local`.
- [ ] **P2. The mini's env file** `~/mymind/env/mymind.env`.
  - Mode 0600, in a 0700 dir, written by hand. The keys are listed in the skill's "Env file" section.
  - Copy `BETTER_AUTH_SECRET` (and `CONFIG_ENC_KEY` if it is set) from LXC 114 unchanged.
  - Set every runtimeConfig key LXC 114's `.env` / `.env.native` set, with its `NUXT_` twin. The mini's build has no `.env` of its own, so nothing is inherited.
  - `deploy/macmini/runtime-env-twins.txt` lists the pairs. `provision-macmini.sh --check` enforces them.
- [ ] **P3. The build box env.** `mkdir -p /opt/mymind-build`, then write `/opt/mymind-build/.env.macmini`.
  - Mode 0600, holding `DATABASE_URL` and `NUXT_DATABASE_URL`, both pointing at `192.168.2.80:5432/bridget`.
  - Do not touch `/opt/mymind`. It stays the rollback target.
- [ ] **P4. Provision the mini (MINI).** Copy `deploy/macmini/` to `~/mymind/deploy/`, run `bash ~/mymind/deploy/provision-macmini.sh`, then run it again with `--check`. The check must exit 0. Nothing starts: the agents load only at CD's first `release.sh restart`.
- [ ] **P5. Preflight on `.80`.** Run in LXC with the DSN from `.env.macmini`, in a subshell, never echoed:
  ```
  ( set -a; . /opt/mymind-build/.env.macmini; set +a; psql "$DATABASE_URL" -X -c "<query>" )
  ```
  Run each query:
  - `select extname, extversion, extnamespace::regnamespace from pg_extension;` — `vector`, `pg_trgm`, `ltree` and `pgcrypto` must all be present and all in `public`.
  - `select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');` — must be `0`.
  - `select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema';` — must be only `public`. In particular, no `drizzle` schema: **nothing may migrate `.80` before the restore**.
  - `select has_schema_privilege('public', 'CREATE'), has_database_privilege(current_database(), 'CREATE');` — both must be `t`.
  - `show timezone;` — if it is not `UTC`, run `alter database bridget set timezone = 'UTC';` (the owner may do this). Prod's better-auth `timestamp without time zone` defaults assume UTC.
  - `show server_version;` — record it (17.x expected).
  - `show max_parallel_maintenance_workers;` and `show dynamic_shared_memory_type;` — record them. A parallel HNSW build puts its graph in dynamic shared memory, sized by `maintenance_work_mem` (1 GB in W3).
  - **Shared memory on the `.80` host.** Run `df -h /dev/shm` there. If Postgres runs in Docker, use `docker inspect -f '{{.HostConfig.ShmSize}}' <container>` instead (Docker's default is 64 MB). If it shows **less than 2 GB, or nobody can check it**, set `PMW=0` in W3, which builds without parallel workers: slower, but it cannot fail with `could not resize shared memory segment`.
- [ ] **P6. Fix any LAN consumer of LXC 114's IP `192.168.2.89`.** The repo has none left outside history.
  - Unmute's `KYUTAI_LLM_URL` on the rig (`ssh tony@192.168.2.25`, `~/unmute/docker-compose.yml`) must become `http://192.168.2.35:3000/api/agent/llm`. Restart Unmute at the window's end.
  - Check any firewall or LAN allowlist that names `.89`.
  - LiteLLM, the rig, Brave and BlueBubbles are already confirmed reachable from the mini. BlueBubbles' webhook uses the public `brain.costanzoclan.com`, which follows Pangolin.
- [ ] **P7. Stage the cutover helpers from the branch.** Neither repo checkout on LXC 114 has them yet: `/opt/mymind` is cycle 85, and `/opt/mymind-build` is filled by the first macmini CD run. From Tony's Mac, in the repo:
  ```
  for f in compare-counts.sh reset-target-db.sh reset-target-db.sql; do
    git show feat/macmini:deploy/macmini/$f | ssh root@192.168.2.50 "pct exec 114 -- tee /root/$f >/dev/null"
  done
  git show feat/macmini:deploy/macmini/copy-uploads.sh | ssh root@192.168.2.50 'tee /root/copy-uploads.sh >/dev/null'
  ssh root@192.168.2.50 'pct exec 114 -- ls -l /root/compare-counts.sh /root/reset-target-db.sh /root/reset-target-db.sql; ls -l /root/copy-uploads.sh'
  ```
- [ ] **P8. Do NOT merge `feat/macmini` yet.** A push to master while `DEPLOY_TARGET` is unset deploys cycle-86 code onto LXC 114.

## The window (in order)

- [ ] **W0. Deny pending approvals for the removed `exec` tool.**
  - **In the app:** answer any open approval card with **Deny**. In-app cards live only in the running worker, and W1 interrupts their runs anyway.
  - **iMessage approvals are persisted.** Check them in LXC:
    ```
    docker exec mymind-db psql -U mymind mymind -Atc "select count(*) from channel_approvals where status = 'pending' and request->>'tool' = 'exec';"
    ```
    Deny any it finds:
    ```
    docker exec mymind-db psql -U mymind mymind -c "update channel_approvals set status = 'denied', resolved_at = now() where status = 'pending' and request->>'tool' = 'exec';"
    ```
  - Also cancel running evals:
    ```
    cd /opt/mymind && set -a && . ./.env.native && set +a && NODE_ENV=production pnpm eval --cancel-all --wait 60
    ```
- [ ] **W1. Stop the old runtime (LXC).** Run `systemctl disable --now mymind mymind-worker`, then check that `systemctl is-active mymind mymind-worker` prints `inactive` twice. Leave `mymind-db` running.
- [ ] **W2. Dump the old DB (LXC).**
  - Use `-Fc` only: no owner flags, which pg_dump ignores for archive formats anyway.
  - pg_dump writes to a file **inside** the container and `docker cp` brings it out, so the archive is seekable, with data offsets for `pg_restore -j`, rather than a pipe.
  - `pg_restore -l` proves the archive reads end to end.
  - Keep the dump in `/root/db-backups`, which CD never wipes. Check that `df -h /root /var/lib/docker` has room for about twice the database size first.
  ```
  mkdir -p /root/db-backups
  DUMP=/root/db-backups/cutover-$(date +%Y%m%d-%H%M).dump
  docker exec mymind-db pg_dump -U mymind -Fc -f /tmp/cutover.dump mymind \
    && docker cp mymind-db:/tmp/cutover.dump "$DUMP" \
    && docker exec mymind-db rm -f /tmp/cutover.dump \
    && pg_restore -l "$DUMP" > /dev/null \
    && echo dump-ok
  ls -lh "$DUMP"
  ```
  It must print `dump-ok`. If the session was lost, recover the variable with `DUMP=$(ls -t /root/db-backups/cutover-*.dump | head -1)`.
- [ ] **W3. Restore into `.80` (LXC).** Use the host `pg_restore` 17.x. Do not migrate first.
  ```
  PMW=3   # 0 when P5 found /dev/shm on .80 under 2 GB, or could not check it
  ( set -a; . /opt/mymind-build/.env.macmini; set +a
    PGOPTIONS="-c maintenance_work_mem=1GB -c max_parallel_maintenance_workers=$PMW" \
      pg_restore --no-owner --no-acl -j 4 -d "$DATABASE_URL" "$DUMP" ) 2> /root/db-backups/restore.log
  echo "exit=$?"
  grep -E '^pg_restore: error' /root/db-backups/restore.log | grep -v 'must be owner of extension'
  ```
  - **Expected:** exit 1 with `errors ignored on restore: N`. Every error line must be a `must be owner of extension …` line. These come from `COMMENT ON EXTENSION` for `vector`, `pg_trgm`, `ltree` and `pgcrypto`, which the non-superuser `bridget` cannot run. The extensions already exist in `public`, so this is harmless.
  - **Never add `-1` or `--exit-on-error`.** Either would abort the whole restore on that noise.
  - **Anything the grep prints is a real failure. Stop and investigate.** For example: `must be owner of table`, `already exists`, a type error or a role error.
  - `--no-owner --no-acl` belong on **pg_restore**. Without them every object emits `ALTER … OWNER TO mymind`, and role `mymind` does not exist on `.80`.
  - `maintenance_work_mem=1GB` keeps the 563 MB HNSW build in memory. At the default 64 MB it spills, and the build becomes far slower.
  - **If the log shows `could not resize shared memory segment`,** `.80`'s `/dev/shm` is too small for the parallel build. Reset `.80` ("Abort / undo", step U-R), then rerun W3 with `PMW=0`.
  - Finally run `analyze`: `( set -a; . /opt/mymind-build/.env.macmini; set +a; psql "$DATABASE_URL" -X -c 'analyze;' )`. pg_restore does not gather statistics.
- [ ] **W4. Compare row counts, table by table (LXC).**
  ```
  ( set -a; . /opt/mymind/.env.native; SRC=$DATABASE_URL; . /opt/mymind-build/.env.macmini; set +a
    bash /root/compare-counts.sh "$SRC" "$DATABASE_URL" )
  ```
  It must end with `every row count matches` and exit 0. It prints each mismatched or one-sided table, and never prints a DSN.
- [ ] **W5. Copy the uploads (PVE).** Run `bash /root/copy-uploads.sh` (staged in P7).
  - It does a tar of `/opt/mymind/.data/uploads` (via `pct exec 114`) over the CD key into the mini's `~/mymind/data/uploads`.
  - It then checks the same file list and the same byte total on both sides, and must print `ok: <n> files, <bytes> bytes on both sides`.
  - LXC 114 has no key to the mini, and the mini's rsync is openrsync. That is why this runs from PVE with tar.
- [ ] **W6. Flip CD to the mini (GH)**, BEFORE anything reaches master:
  ```
  gh variable set DEPLOY_TARGET --body macmini
  gh variable set MYMIND_CUTOVER_DONE --body true
  ```
  From here on, every push builds in `/opt/mymind-build` and deploys to the mini, and the `[lxc]` path refuses to run.
- [ ] **W7. Merge `feat/macmini` into master and push (GH).**
  - The push runs `deploy.yml` with target `macmini`. It syncs and builds in `/opt/mymind-build`, provisions the mini and stages both releases (with the dlopen checks).
  - It then cancels evals and migrates `.80`, which is a no-op because the restore brought the `drizzle` ledger.
  - Finally it activates and bootstraps the web, gates on `/api/health` reporting this sha over the LAN, then activates the worker and gates on its heartbeat. Any failure or cancel rolls back both.
  - Watch it with `gh run watch <id> --exit-status`, never piped to `tail`.
  - If the push did not trigger a run: `gh workflow run deploy.yml --ref master -f target=macmini`.
- [ ] **W8. Smoke test on the LAN** (`http://192.168.2.35:3000`). These checks do not need the public URL:
  - `/api/health` returns 200 with the merge sha.
  - Log in.
  - A chat turn.
  - A workstream `bash` command (for example `uptime`).
  - A Brave `web_search`.
  - An **outbound** iMessage. The mini reaches BlueBubbles directly.
  - On the mini, `bash ~/mymind/bin/release.sh status` shows both releases, and `tail ~/Library/Logs/mymind/worker.log` is clean.
  - **Not yet:** MCP and inbound iMessage both come in through the public `brain.costanzoclan.com`, which still points at the stopped `.89`. A failure there now is expected and is NOT a reason to roll back.
- [ ] **W9. Point Pangolin at `192.168.2.35:3000`.** Check the external `https://brain.costanzoclan.com/api/health`. Restart Unmute with the new `KYUTAI_LLM_URL` (P6). Prod is back up.
- [ ] **W10. Smoke test through the public URL:**
  - An MCP round trip, for example any `mcp__mymind__*` call from Claude Code.
  - An **inbound** iMessage: text Bridget and get a reply.
  - Texts sent during the window are recovered by the channel catch-up, which reaches back at most 24 h.

## After the window

- [ ] **A1. Run `bridget-core` evals on prod** from `/opt/mymind-build` with `.env.macmini` (see the prod-deploy skill, Evals).
- [ ] **A2. Remove the orphan search container (LXC):** `docker rm -f mymind-searxng`.
  - `/opt/mymind`'s compose file is still cycle 85's, and it declares searxng, so `--remove-orphans` would not remove the container.
  - Keep `mymind-db`, its volume, `/opt/mymind` (its `.output` and `.worker`) and the units' files for **7 days**. Together they are the rollback.
- [ ] **A4. Reboot test (optional, recommended).** Reboot the mini and confirm both agents return via autologin and `/api/health` is 200. Do not touch BlueBubbles.
- [ ] **A5. Mini cleanup (Task 4 / D9).** Remove the leftover `hermes@ct140` key from the mini's `authorized_keys`, and `~/.hermes` once Tony confirms.
- [ ] **A6. After 7 days with no rollback,** stop and remove `mymind-db` and its volume in LXC 114, after a final dump to `/root/db-backups`.
- [ ] **A7. After 7 days with no rollback, remove the cycle-82 sandbox runtime from LXC 114.** Not earlier: the rollback target's cycle-85 worker needs it for workspace commands.
  - Follow task-3-report "Cutover runbook additions": the `mymind-sandbox-net` unit, `/usr/local/lib/mymind`, the `MYMIND-SANDBOX-*` iptables chains, the `mymind-sandbox` network and image, any `label=mymind.workspace` containers, and `/opt/mymind/.workspaces` once checked.

## Abort / undo during the window

Find the last step that completed, and undo from there. Each block lists exactly what to run. Pangolin moves only at W9, so before W9 the public URL still points at `.89`.

**After W0 or W1, before W6** (`.80` maybe partly restored; nothing reached master; the mini runs nothing):

1. LXC: `systemctl enable --now mymind mymind-worker`, then `systemctl is-active mymind mymind-worker` must print `active` twice.
2. Check the external `https://brain.costanzoclan.com/api/health`. Prod is back on the old runtime and the old DB, and nothing was lost.
3. Before any retry, reset `.80` (step U-R below). On the mini, empty the uploads copy (`rm -rf ~/mymind/data/uploads/*`). Nothing serves from it yet, and `copy-uploads.sh` would flag stale files.

**After W6, before the W7 push** (the variables are set, master is unchanged):

1. Do the steps above.
2. GH: `gh variable delete DEPLOY_TARGET` and `gh variable delete MYMIND_CUTOVER_DONE`. Pushes go back to the lxc path, which is safe only because master still holds no cycle-86 code.

**After W7, before W9** (master holds cycle 86; the mini may be running it; Pangolin still points at `.89`):

1. MINI, so there is never a second worker:
   ```
   launchctl bootout gui/$(id -u)/com.mymind.worker
   launchctl bootout gui/$(id -u)/com.mymind.web
   ```
   `launchctl print gui/$(id -u)/com.mymind.web` must then fail, and the same for the worker.
2. LXC: `systemctl enable --now mymind mymind-worker`, then check that both are active and the external `/api/health` answers.
3. **Leave `DEPLOY_TARGET=macmini` and `MYMIND_CUTOVER_DONE=true` set.** Master now holds cycle 86, and the lxc path would build it onto the old DB. Pushes fail harmlessly at `--build-only`.
4. To retry:
   1. Reset `.80` (U-R) and empty the mini's uploads.
   2. Redo W0–W5 with a fresh `$DUMP`.
   3. Instead of merging (it is already merged), run `gh workflow run deploy.yml --ref master -f target=macmini`.

**After W9:** use "Rollback" below. Pangolin, Unmute and the variables are covered there.

**U-R. Reset `.80` to empty (LXC, `pct enter 114`).** The script was staged in P7. It drops the `drizzle` schema, plus every relation, routine and type in `public` that `bridget` owns and that is not an extension member. The superuser-owned extensions stay. It never runs `drop owned`. It runs in one transaction, and refuses unless it gets `--i-know` and a DSN for `192.168.2.80/bridget`.
```
( set -a; . /opt/mymind-build/.env.macmini; set +a
  bash /root/reset-target-db.sh --i-know "$DATABASE_URL" )
```
It must print `reset-target-db: done`. Then rerun the P5 queries: 0 tables, only `public`, extensions still in `public`.

## Rollback: back to LXC 114 (within 7 days)

No workflow run is needed. Macmini deploys never write `/opt/mymind`, so its `.output` and `.worker` are still the pre-cutover build, and `mymind-db` still holds the pre-cutover data.

1. **MINI:** stop both agents, so there are never two workers:
   ```
   launchctl bootout gui/$(id -u)/com.mymind.worker
   launchctl bootout gui/$(id -u)/com.mymind.web
   ```
2. **LXC:**
   ```
   cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d db
   systemctl enable --now mymind mymind-worker
   ```
3. Point Pangolin back at `192.168.2.89:3000` and check the external `/api/health`. Point Unmute's `KYUTAI_LLM_URL` back at `.89`.
4. **Leave `DEPLOY_TARGET=macmini` and `MYMIND_CUTOVER_DONE=true` set.**
   - A push then fails harmlessly at `--build-only`, because the LXC units are active.
   - Never switch to `lxc`: that would build new code onto the old database.
   - As a backstop, a cycle-86 build on Linux refuses every workspace command in production (`workspace unavailable on this host`) unless `MYMIND_HOST_RUNTIME_ALLOWED=1` is set. Never set it on LXC 114.
5. **Data written to `.80` since the cutover is NOT in the LXC database.** Reconcile it by hand if it matters.

To return to the mini afterwards:

1. Decide which data wins. **The reset discards everything `.80` holds**, including whatever was written there before the rollback. Export anything worth keeping first.
2. LXC: `systemctl disable --now mymind mymind-worker`.
3. Reset `.80` (U-R), then redo W2–W5 with a fresh `$DUMP`. That means dump, restore, compare and uploads; empty the mini's uploads dir first.
4. MINI: `bash ~/mymind/bin/release.sh restart web`, then `bash ~/mymind/bin/release.sh restart worker`. Both bootstrap the agents that were booted out. Then run `bash ~/mymind/bin/release.sh health worker 120`.
5. Smoke test as in W8, point Pangolin at `192.168.2.35:3000`, then do W10.
