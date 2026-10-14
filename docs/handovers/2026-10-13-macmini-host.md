---
title: "Mac mini host — Bridget owns the machine; native web + worker on the mini, central Postgres, Brave-only search (cycle 86, harness step 7)"
cycle: 86
date: 2026-10-13
status: deployed  # 2026-10-14 cutover; CD 38482662776 (f130f15); prod bridget-core 23/23
branch: feat/macmini (worktree .claude/worktrees/feat+sandbox, base master 2cb28f7)
merged: true
deployed: true
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
next: finish acceptance (inbound iMessage, reboot test, SearXNG + hermes key cleanup, Unmute LLM URL), then on/after 2026-10-20 retire LXC 114's mymind-db + runtime; harness step 6b (optimizer) is still open
---

# Mac mini host (cycle 86)

MyMind's web app and agent worker move to the dedicated Mac mini (`bridget.local`, `192.168.2.35`,
M1 8 GB, macOS 15, user `bridget`), which already runs BlueBubbles. They run natively under launchd
against Tony's **central Postgres** (`192.168.2.80`, database `bridget`). LXC 114 stays as the CI
**build box** only. Bridget's workspace is no longer a Docker container: it is a directory on her own
Mac and every command is a plain host process as `bridget`. Host `exec` and the `admin` toolset are
gone. Search is Brave only.

**Status: deployed (cutover 2026-10-13 23:00 UTC).** Current-state reference:
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

**Final whole-branch review and fix wave** (base `67560fc`, head `3596b6b`). The review
(`3741121..67560fc`) said *not ready*: **C1** merging before the window would deploy the cycle-86 worker
onto LXC 114 as an unconfined, approval-free root shell; I1 an under-specified restore; I2 LXC rollback
overwritten by macmini builds; I3 the window estimate; I4 stale docs. All landed:
- `0dce140` C1 **production platform guard** (`hostRuntimeRefusal` in `sandbox/manager.ts`: in production a
  non-eval workspace command is refused unless the platform is `darwin` or `MYMIND_HOST_RUNTIME_ALLOWED=1`;
  `health()` reports the same reason).
- `86bd12e` macmini builds go to a **separate `/opt/mymind-build`** (LXC 114's `.output` and `.worker` stay
  the cycle-85 rollback; `build-artifacts.sh` refuses to run in `/opt/mymind`, symlinks resolved),
  `prune-arch.sh` with a platform assertion (linux-x64 and darwin-arm64 `*.node` must remain), health bound on
  the DB clock, rollback also on cancelled runs.
- `932fd42` the mini's `NUXT_` twin check is derived from the config mapping
  (`deploy/macmini/runtime-env-twins.txt` + `check-env-twins.sh`, drift-tested).
- `b604f12` the SHELL prompt block names the host from runtime facts (`promptHost()`); stale sandbox wording
  dropped; `runNetworkMode` renamed `runTaintMode` (`'offline'` -> `'unverified'`; the bus wire field
  `offline` on `workspace-read-text` is unchanged to avoid web/worker skew).
- `a61dea3` limiter sleep timer cleared on abort; busy error tells the model to slow its fan-out.
- `e5f0870` **`deploy/macmini/CUTOVER.md`**, `compare-counts.sh`, `copy-uploads.sh`, the LXC rollback, the
  `.89` -> `.35` doc updates, `prod-deploy` skill.
- `8bbaee3` test follow-up for the rename; `3596b6b` wiring tests for prune-arch and the twin check.
37 of 37 mutations killed.

## Counts and range

- **Counts (final-fix report):** unit **4690 passed / 1 skipped** (was 4651/1), db **1293 passed**
  (`MYMIND_BUS_NS=c86-finalfix`, no rows left behind). `pnpm typecheck`, `pnpm build` and the worker build +
  stage were green. `memory-search-contradicts` is the pre-existing flaky db test (failed once, passed on
  rerun). `typecheck` does not cover `test/`: the rename broke a db test only `test:db` caught (`8bbaee3`).
- **Range:** branch base is master `2cb28f7`; branch commits `5fa0559` (spec) through `3596b6b` (HEAD before
  this docs commit). SDD ledger and reports: `.superpowers/sdd/2026-10-13-macmini-host/`.
- **No migration.** The `workspaces` columns `container_id`, `bytes_used`, `inodes_used` stay but are
  unused (container id always null; no quota to measure).

## Cutover runbook

The canonical, ordered checklist is **[`deploy/macmini/CUTOVER.md`](../../deploy/macmini/CUTOVER.md)**
(committed, no secrets). Summary:

- **Window: 30 to 60 minutes dark** (not the spec's 15): the 563 MB HNSW rebuild on restore plus the first
  CD run (test job, clean cross-arch install, Nuxt build, ~711 MB tar, gates). Pre-building via CD is blocked
  on purpose; the optional pre-warm is to copy the branch into `/opt/mymind-build` and `pnpm install`.
- **Before:** runner key, the mini's env file (twins per `runtime-env-twins.txt`),
  `/opt/mymind-build/.env.macmini`, provision + `--check`, `.80` preflight, repoint `.89` consumers
  (Unmute `KYUTAI_LLM_URL`), stage `compare-counts.sh` and `copy-uploads.sh`. Do not merge yet.
- **Window:** W0 deny pending `exec` approvals and cancel evals; stop the LXC units; `pg_dump -Fc` and
  `pg_restore --no-owner --no-acl -j 4` (no `-1`, no `--exit-on-error`; "must be owner of extension" noise
  filtered); `compare-counts.sh`; `copy-uploads.sh`; set `DEPLOY_TARGET=macmini` and `MYMIND_CUTOVER_DONE`
  **before** merging; merge and watch CD; LAN smoke test; Pangolin + Unmute to `.35`.
- **Rollback (7 days, no workflow run):** boot out the mini's agents, `docker compose up -d db` and
  `systemctl enable --now mymind mymind-worker` in LXC 114 (cycle-85 code, old DB, untouched because
  macmini builds use `/opt/mymind-build`), Pangolin and Unmute back to `.89`. **Leave `DEPLOY_TARGET=macmini`
  and `MYMIND_CUTOVER_DONE` set** (never switch to `lxc`: that would build new code onto the old DB; pushes
  fail harmlessly at `--build-only`). Rows written on `.80` since cutover are not in the old DB.

**Controller-verified preflight (done):**
- In LXC 114, `docker exec mymind-db pg_dump` / `psql -U mymind` work without a password.
- LXC 114's `.env.native` DSN points at localhost (so the source DSN for the count compare works).
- `.80` is PG 17.6, empty, extensions present in `public`, `timezone` UTC, `max_connections` 1000.

Still unproved until W7: the first real linux-x64 -> darwin-arm64 build in `/opt/mymind-build` (a red deploy
before any restart if it fails, not an outage).

## Cutover result (2026-10-13/14)

- **Window:** LXC units stopped 23:00:21Z; `pg_dump -Fc` 1.2 GB (`/root/db-backups/cutover-20261013-2300.dump`);
  restore into `.80` in 126 s (4 expected extension-comment errors); 66 tables, every row count matched;
  99 uploads (71,128,136 bytes) copied; `DEPLOY_TARGET=macmini`, `MYMIND_CUTOVER_DONE=true`.
- **CD:** first run 38482036624 failed in `test` (two Linux-vs-mac assumptions: BSD `stat` in `run.sh`, the
  prompt test reading the CI host's platform) — no restart happened. Fixed in `f130f15`; CD 38482662776 green,
  web + worker at `f130f15` under launchd, worker `host runtime ok`.
- **Pangolin:** the resource was retargeted to `http://192.168.2.35:3000` by Tony; it 503'd ("no available
  server") until Tony fixed the target on the Pangolin side. Public `/api/health` now returns the sha.
- **Acceptance (passed):** public health + MCP round trip; Brave `web_search` via prod; LAN from the mini
  (`.80:5432`, LiteLLM `.85:4000`); outbound iMessage via BlueBubbles (`sent`); `gh` on the mini logged in as
  Patrity (`repo`, `workflow`), `git ls-remote` ok; **prod bridget-core 23/23** (run `ea2edea5`, 68/68
  attempts, mean 1.00, 2.33M tokens, 717 s; cycle-85 baseline was 20/21) — includes `mac-uptime`,
  `workspace-*`, `task-delete-confirms` 3/3.
- **Still open:** inbound iMessage reply; reboot test (no passwordless sudo — restart from the GUI or via
  System Events); `docker rm -f mymind-searxng` on LXC 114; drop the `hermes@ct140` key from the mini's
  `authorized_keys`; Unmute's `KYUTAI_LLM_URL` (no Unmute found on the rig `192.168.2.25` any more — location
  unknown); retire LXC 114's `mymind-db` + runtime on/after 2026-10-20.
- The rig's `:8004` refuses connections from the mini; prod routes through LiteLLM, so not a blocker.

## Open at write time

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
