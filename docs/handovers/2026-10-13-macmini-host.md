---
title: "Mac mini host — Bridget owns the machine; native web + worker on the mini, central Postgres, Brave-only search (cycle 86, harness step 7)"
cycle: 86
date: 2026-10-13
status: built  # awaiting cutover (Tony, 30-60 min window); not merged, not deployed
branch: feat/macmini (worktree .claude/worktrees/feat+sandbox, base master 2cb28f7)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-10-13-macmini-host-design.md
plans:
  - ../superpowers/plans/2026-10-13-macmini-host.md
wiki:
  - ../wiki/workspace.md
  - ../wiki/agent-exec.md
  - ../wiki/agent.md
  - ../wiki/judge.md
  - ../wiki/eval.md
  - ../wiki/web-research.md
  - ../wiki/search.md
  - ../wiki/core-package.md
  - ../DEPLOYMENT.md
migrations: none  # additive-free cycle; workspaces.container_id / bytes_used / inodes_used stay but are unused
next: cutover (runbook below), then 7 days later retire LXC 114's runtime; harness step 6b (optimizer) is still open
---

# Mac mini host (cycle 86)

MyMind's web app and agent worker move to the dedicated Mac mini (`bridget.local`, `192.168.2.35`,
M1 8 GB, macOS 15, user `bridget`), which already runs BlueBubbles. They run natively under launchd
against Tony's **central Postgres** (`192.168.2.80`, database `bridget`). LXC 114 stays as the CI
**build box** only. Bridget's workspace is no longer a Docker container: it is a directory on her own
Mac and every command is a plain host process as `bridget`. Host `exec` and the `admin` toolset are
gone. Search is Brave only.

**Status: built, awaiting cutover.** Nothing is merged to master or deployed. Current-state reference:
[`wiki/workspace.md`](../wiki/workspace.md) and [`DEPLOYMENT.md` § 23](../DEPLOYMENT.md#23-mac-mini-host-cycle-86).

## Option C: Bridget owns the Mac, no agent confinement

The original plan (spec D6) ran a *tainted* run's commands under `sandbox-exec` (no network, writes only
in the workspace, no secrets) as a switchable trial. Task 1's review and two re-reviews **probed real
escapes** out of that deny-list profile: `cfprefsd` writes (`defaults write`), keychain reads via
`securityd`, an open-ended service list (`shortcuts`, `imagent`, `sharingd`), and then, in the second
re-review, `LSOpenCFURLRef` (LaunchServices) opening a URL or app from a confined process, which carries
data past the network deny. Each fix exposed the next out-of-process service.

**Tony's decision (2026-10-13), option C: drop confinement for agent runs entirely.** Removed: the
`agent.taintConfinement` setting, the confined chip and `sandbox:confined` activity, the "Re-enable
network" flow (`POST /api/workspaces/:id/reenable-network` deleted), refusal of shells/watches in tainted
runs. Kept: run taint still gates outbound tools and feeds the judge (cycles 79b/84); a tainted workspace
still taints the runs that read it (a taint *source*), and Tony clears it with **Mark trusted**
(`POST /api/workspaces/:id/trust`, session-only, records `workspace:trusted`). `sandbox-exec` stays for
**eval worlds only** (harness isolation), with the LaunchServices denies (`^com\.apple\.coreservices\.`,
`^com\.apple\.lsd\.`) proved by a real LSOpen probe test, every profile path realpath-resolved, and
FIFO-safe exports. A tainted run can therefore `curl` out or read `~/mymind/env/mymind.env`; that is
accepted and was not re-litigated in the final review. The spec carries an amendment (commit `cc8f003`).

## What shipped, per task

**Task 1: native host runtime** (`8ea1102`, `52ef28a`, `af09abc`, `649adff`, `513c413`, `7ba5db8`,
`36c6b2f`; spec amendment `cc8f003`). `packages/core/src/lib/sandbox` now hosts the host runtime:
`host/spawn.ts` (`bash -c` in its own process group; timeout SIGTERM, SIGKILL after 2 s, then SIGKILL until
the group is empty; abort SIGKILLs at once; tail-kept output caps), `host/env.ts` (her login env, secret-name
deny list), `host/profile.ts` (the eval-only profile), `host/copy.ts` (`export_to_coordinator` host-side
copy, symlinks skipped). Workspaces live in `~/mymind/workspaces/<id>`; relative paths resolve inside the
workspace, absolute paths go anywhere; no concurrency cap, no quota. Background shells are process groups
that survive worker restarts and re-attach by pid + argv mark. **Low-disk alarm**: free space < 5 GB
pauses new workspace work and texts Tony once per episode, resume at 8 GB. Removed: `docker.ts`,
`network.ts`, `quota.ts`, `deploy/sandbox/`, host `exec` (tool, `execRule`, `admin` toolset, exec-approvals
settings UI and routes), the Docker tests. The `exec-needs-approval` eval case became `mac-uptime`. The SHELL
prompt block, toolset directory line and tool descriptions describe the Mac. Wiki pages rewritten in the
docs pass (this handover's commit).

**Task 2: Brave only, rate limited** (`cf1d50c`, `13bde9d`, `a9874a4`, `af80b26`, `1bb6d23`).
SearXNG provider, settings, config dir and the compose service deleted; legacy `provider: 'searxng'` rows
load as Brave. A per-process token bucket (default 1 req/s, burst 3, setting `search.brave.qps`) is shared
by `web_search` and every `research_web` fan-out call. Review fix round: the acquire is abortable, a queued
call waits at most **60 s** then fails fast with `SearchBusyError`, a 429 is retried up to 3 times with an
overall **45 s deadline**, the retry sleep is abortable and the tool signal is threaded through.

**Task 3: Mac mini deploy** (`7ee1cce`, fix round `ee8b02b`; merge of master `67560fc`).
`deploy/macmini/`: `provision-macmini.sh [--check]`, `release.sh` (stage / activate / rollback / restart /
health / undo / status over symlink release pointers), `run.sh` (launchd wrapper, log rotation), the two
plists, `build-artifacts.sh`. `deploy.yml` gains the `[lxc]` / `[macmini]` step families. Cross-arch native
modules (linux build, darwin runtime) via `supportedArchitectures` in `pnpm-workspace.yaml`; staging
refuses a release whose darwin `*.node` files do not `dlopen`. Fix round: health gates prove the **new**
pid and git sha (`/api/health` returns `{ok, sha}`), a final rollback step on any failure, the
*Refuse after cutover* guard, plist changes applied only inside the gated restart. Deviations: no
newsyslog (the wrapper rotates), tar over ssh not rsync (the mini's rsync is Apple's openrsync),
migrations run from LXC 114 against `.80` not on the mini. Full detail: [`DEPLOYMENT.md` § 23](../DEPLOYMENT.md#23-mac-mini-host-cycle-86)
and the `prod-deploy` skill (rewritten for the mini).

**Final whole-branch review and fix wave.** The review (`3741121..67560fc`) said *not ready*: **C1**
merging before the window would deploy the cycle-86 worker onto LXC 114 as an unconfined, approval-free
root shell; I1 an under-specified restore; I2 LXC rollback overwritten by macmini builds; I3 the window
estimate; I4 stale docs. Fix wave so far on the branch: `0dce140` **production platform guard**
(`hostRuntimeRefusal`: in production a non-eval workspace command is refused unless the platform is
`darwin` or `MYMIND_HOST_RUNTIME_ALLOWED=1`), `86bd12e` macmini builds go to a **separate
`/opt/mymind-build`** (so LXC 114's `.output` and `.worker` stay the cycle-85 rollback), `prune-arch.sh`
with a platform assertion, DB-clock health bound, rollback on cancelled runs. The brief also covers the restore
runbook plus a table-by-table count compare script, the uploads copy script, host facts in the prompt,
an env check derived from the config mapper, and the parked minors. **At the time of writing these
were still landing; check `git log feat/macmini` and `deploy/macmini/`** (a `CUTOVER.md` and
`compare-counts.sh` are expected there). If `deploy/macmini/CUTOVER.md` exists, it supersedes the
condensed runbook below.

## Counts and range

- **Counts (from the task reports; no final-fix report existed when this was written):** unit **4651 passed
  / 1 skipped**, db **1293 passed** (Task 3 fix round 1, the latest report). Earlier: Task 1 4599/1 + 1290;
  Task 2 4613/1 + 1293; Task 3 4637/1 then 4651/1. One db test, `memory-search-contradicts`, fails on the
  base too (pre-existing, noted in Task 1). `pnpm typecheck` and `pnpm build` were green at each report.
  Re-take the counts from the final-fix report once it lands.
- **Range:** branch base is master `2cb28f7`; branch commits `5fa0559` (spec) through `86bd12e` (21 commits at
  the time of writing, more to come with the fix wave). SDD ledger and reports:
  `.superpowers/sdd/2026-10-13-macmini-host/`.
- **No migration.** The `workspaces` columns `container_id`, `bytes_used`, `inodes_used` stay but are
  unused (container id always null; no quota to measure).

## Cutover runbook (condensed)

Expected window: **30 to 60 minutes of downtime**, not the 15 minutes in the spec. The site is dark from
the moment the LXC units stop: dump, restore (the `messages_embedding_hnsw` index alone is ~563 MB and
rebuilds on restore), then the first macmini CD run (the `test` job, a clean cross-arch `node_modules`
install, the 4 GB-heap Nuxt build, the worker build, a ~711 MB tar over ssh, the gates).

**Tony's one-time steps (before the window):**
1. **Runner SSH key.** On the Proxmox host: `ssh-keygen -t ed25519 -N "" -C mymind-cd -f /root/.ssh/mymind_macmini`;
   append the `.pub` to `/Users/bridget/.ssh/authorized_keys` on the mini; `ssh-keyscan -t ed25519 192.168.2.35
   >> /root/.ssh/known_hosts` (CD pins the host key); verify `ssh -i /root/.ssh/mymind_macmini -o BatchMode=yes
   bridget@192.168.2.35 hostname`.
2. **The env file `~/mymind/env/mymind.env`** on the mini (0600 in a 0700 dir; bash-sourced `KEY=value`
   lines, quote values with spaces, `$`, `#`). Key names are in `.env.example` (Mac mini section) and the
   skill; never write values into docs. Copy `BETTER_AUTH_SECRET` (and `CONFIG_ENC_KEY` if set) from LXC 114
   **unchanged**. Every runtimeConfig key needs its `NUXT_` twin. Also `/opt/mymind-build/.env.macmini` in LXC
   114 (0600): `DATABASE_URL` **and** `NUXT_DATABASE_URL` pointing at `.80`.
3. **`gh auth login` as Patrity** on the mini (as `bridget`), full access (accepted risk, D8).

**Preflight (controller):**
- Mini: copy `deploy/macmini` to `~/mymind/deploy`, run `bash ~/mymind/deploy/provision-macmini.sh`, then with
  `--check` (must exit 0). Hermes retirement (D9): unload `ai.hermes.serve`/`ai.hermes.gateway`, archive
  `~/.hermes`, remove the leftover `hermes@ct140` key from `authorized_keys`, stop the old Homebrew
  `postgresql@16`. Never touch BlueBubbles.
- `.80`: extensions `vector`, `pgcrypto`, `pg_trgm`, `ltree` present **in `public`**
  (`select extname, extnamespace::regnamespace from pg_extension`); database empty (`\dn`, `\dt`); `show timezone`
  (if not UTC, `ALTER DATABASE bridget SET timezone='UTC'`). **Do not run any migration before the restore**
  (it would create the schema and the `drizzle` ledger and the restore would collide).
- Deny pending `exec` approvals (the tool no longer exists; a dangling card cannot be decided).
- Check external consumers of LXC 114's IP: unmute's `KYUTAI_LLM_URL` and anything naming `192.168.2.89`.
- **Set the repo variable `DEPLOY_TARGET=macmini` BEFORE merging** (final review C1): a push with it unset
  takes the `lxc` path and would run the cycle-86 worker on LXC 114. The platform guard and the *Refuse
  after cutover* step are backstops, not the plan. Merge only inside the window, or run
  `gh workflow run deploy.yml --ref master -f target=macmini` once master holds the code.

**Window:**
1. `systemctl disable --now mymind mymind-worker` in LXC 114.
2. `pg_dump -Fc` (no owner flags) from `mymind-db`, then `pg_restore --no-owner --no-acl -j 4` into
   `.80`/`bridget` with `PGOPTIONS='-c maintenance_work_mem=1GB'`; use LXC 114's host `pg_restore` (17.x).
   No `-1`, no `--exit-on-error`. Expect "must be owner of extension" errors on `COMMENT ON EXTENSION`; that
   noise is fine. Put dumps in `/root/db-backups`, not in the CD-wiped `/opt/mymind`.
3. Compare row counts table by table (`deploy/macmini/compare-counts.sh <srcDSN> <dstDSN>` if the fix wave
   shipped it; non-zero exit on any mismatch). Do not proceed on a mismatch.
4. Uploads (~69 MB) from the Proxmox host, which holds the runner key: `pct exec 114 -- tar -C
   /opt/mymind/.data/uploads -cf - . | ssh -i /root/.ssh/mymind_macmini bridget@192.168.2.35 'tar -x -C
   ~/mymind/data/uploads -f -'`. Compare file counts.
5. Merge and push (CD takes the `macmini` path) or `gh workflow run deploy.yml --ref master -f target=macmini`;
   `gh run watch <id> --exit-status`. It builds in `/opt/mymind-build`, stages, cancels evals, migrates `.80`
   (a no-op after the restore), activates, and health-gates web (sha) then worker (new pid).
6. Smoke test: `/api/health` 200 over the LAN, an MCP round trip, a chat turn, a workstream with a
   workspace command (also confirms the platform guard allows the mini), a Brave search, iMessage send and
   receive via BlueBubbles.
7. Retarget Pangolin to `192.168.2.35:3000`; check the external `/api/health`.
8. `gh variable set MYMIND_CUTOVER_DONE --body true`.
9. In LXC 114 remove the orphan search container (`docker compose -f docker-compose.prod.yml up -d
   --remove-orphans db`). Optional: reboot the mini and confirm both agents return via autologin.

**Rollback (within 7 days, no workflow run):** re-enable and start `mymind` and `mymind-worker` in LXC 114
(they still run the cycle-85 code against the untouched old database), `launchctl bootout` the mini's two
agents, and point Pangolin back. Rows written on `.80` after cutover are not in the old database. To make
CD target LXC again set `DEPLOY_TARGET=lxc` and **delete** `MYMIND_CUTOVER_DONE`.

## Open at write time

- The SHELL prompt block still hardcodes "a Mac mini"; the fix wave is to derive host name and platform
  from runtime facts. `coordinator.ts` ("its own sandbox") and a comment in `agent/index.vue` were stale too.
- `runNetworkMode`'s `'offline'` naming in `tools/workspace.ts` is cosmetic leftover from the confinement trial.
- Task 2 minors: the default sleep timer is not cleared on abort; the busy text could tell the model to slow
  its fan-out.
- `/api/health` publishes the deployed short sha to the internet (accepted).
- Dev is a full-trust host: on Tony's Mac the dev worker runs her `bash` as him, with no approval.
- The first real linux-to-darwin native run happens at the first macmini deploy; staging fails closed (a red
  deploy before any restart, not an outage).

## Backlog (also in `docs/BACKLOG.md`, "Cycle 86 backlog")

- **Mach-lookup allow-list for eval worlds** (today a deny-list of known services).
- **`sandbox-exec` deprecation risk** (Apple marks it deprecated; evals would stop if it breaks).
- **Retire LXC 114's runtime 7 days after cutover** (units, `mymind-db`, the cycle-82 sandbox leftovers).
- **Backups of `.80` are the homelab's job** (Tony confirms a schedule; MyMind runs no DB dumps; uploads on
  the mini are not backed up yet).
- Hard link inside an eval world, dev full-trust host, and the prod baseline for `mac-uptime` (it replaced
  `exec-needs-approval`; no prod baseline yet; the suite is now 23 cases).
