---
title: "Mac mini host — MyMind runs natively on the agent Mac (bridget user), central Postgres, native workspace with sandbox-exec for tainted runs, Brave-only search (cycle 86, harness step 7)"
cycle: 86
date: 2026-10-13
status: spec
supersedes: null
builds_on: 2026-10-13-eval-design.md
---

# Mac mini host (cycle 86 — harness step 7)

Bridget's hands move to the machine built for agent work. The Mac mini (`bridget.local`,
`192.168.2.35`, Apple M1 8 GB, macOS 15.8, user `bridget`) is a dedicated agent box — not used
personally — that already runs BlueBubbles and (until now) Hermes. MyMind's web app and worker run
there natively as `bridget`, using its CLI tools and logins; data moves to Tony's central Postgres; the
Docker sandbox and host `exec` are retired in favour of a native workspace; SearXNG is retired.

## 1. Decisions (brainstorm 2026-10-13)

| # | Decision | Rejected |
|---|---|---|
| D1 | Web + worker run **natively on the mini** as `bridget` under launchd (KeepAlive). BlueBubbles stays | worker-only on the mini; everything on the mini incl. DB |
| D2 | Database = **central Postgres** `192.168.2.80:5432`, db `bridget`, role `bridget` (owner; PG 17.6; vector 0.8.1, pgcrypto, pg_trgm, ltree pre-installed by the homelab agent) | Postgres on the mini; keep `mymind-db` in LXC 114 |
| D3 | **Retire SearXNG**; **Brave** is the only web-search backend, with a client-side rate limiter + retry | SearXNG on the mini; proxy round-robin |
| D4 | **Build on LXC 114** (16 GB, existing toolchain) as the CI build box; CD ships the web `.output` + worker release to the mini over SSH, migrates against `.80`, restarts launchd services; rollback = release-dir swap | build on the 8 GB mini |
| D5 | **Bridget owns the machine.** Workspace tools run as `bridget`; `~/mymind/workspaces/<workspaceId>/` is her default working/storage dir (relative paths resolve there; absolute paths go anywhere). Full filesystem, **full network (LAN + internet)**, any CLI, no approvals, **no command-concurrency cap, no per-workspace quota** (only a low-disk alarm). Docker sandbox and host `exec`/admin toolset retired | keep Docker (OrbStack) sandbox; path containment; process caps |
| D6 | **Taint confinement (trial)**: only a run tainted by mail/calendar reads or a guard flag runs its commands under macOS `sandbox-exec` — no network, writes only inside the workspace, no secrets; background shells/watches refused; "Re-enable network" unchanged. Tony is skeptical it is worth it: it is **one setting** (`agent.taintConfinement`, default on) and every confinement is logged (`sandbox:confined` activity + a chip in the thread) so its real cost can be judged | approval card per command; no guard at all |
| D7 | **Evals**: per-world schemas on `.80` unchanged; eval workspace commands always run under `sandbox-exec` (offline, scratch dir); host-level commands refused | Docker for evals only |
| D8 | **Credentials** live in `bridget`'s macOS account (gh, git, ssh). GitHub: **re-auth `gh` as Patrity (Tony's account), full access** — accepted risk on a dedicated box. MyMind's secrets "sandbox" opt-in becomes "export to Bridget's shell"; never in tainted runs | separate GitHub account; fine-grained token |
| D9 | **Cleanup**: retire Hermes (unload `ai.hermes.serve`/`ai.hermes.gateway`, archive `~/.hermes`), stop/remove the old Homebrew `postgresql@16` service, reclaim disk; **never touch BlueBubbles** | — |
| D10 | **Cutover** (≈ 15 min window): stop LXC 114 app → `pg_dump --no-owner --no-acl` → restore into `.80` → rsync `/opt/mymind/.data/uploads` to the mini → start mini services → retarget Pangolin → verify. LXC 114 keeps its DB + data **untouched for a week** (rollback), then becomes build-only | in-place dual-write |
| D11 | Backups of `.80` are the homelab's responsibility (Tony confirms); the mini backs up uploads | MyMind-run DB dumps |

## 2. Topology

```
Pangolin (public) ──> mini :3000  web (launchd com.mymind.web, node .output/server/index.mjs)
                      mini        worker (launchd com.mymind.worker, ~/mymind/.worker/worker.mjs)
                      mini        BlueBubbles (unchanged) ← iMessage channel now local
                      mini        ~/mymind/{app,.worker,.worker-prev,data/uploads,workspaces,evals-scratch}
both ──> Postgres 192.168.2.80:5432 (db bridget)        LiteLLM 192.168.2.85:4000 / rig 192.168.2.25
LXC 114 ── CI build box (self-hosted runner on Proxmox drives it) ── rsync/ssh ──> mini
```
Env: `~/mymind/app/.env` (+ `.env.native`-equivalent `~/mymind/env/mymind.env`) with `DATABASE_URL`
and `NUXT_DATABASE_URL` → `.80`; `NUXT_STORAGE_LOCAL_DIR` → `~/mymind/data/uploads`;
`NITRO_HOST=0.0.0.0`, `NITRO_PORT=3000`; `AGENT_RUNTIME_EXCLUSIVE=1` on the worker.

## 3. Native workspace (replaces cycle 82's container runtime)
- `packages/core/src/lib/sandbox` gains a **host runtime** implementing the manager interface (`exec`,
  background shells, watches, file ops) with no container: `spawn` as `bridget`, `cwd` = the workspace
  dir, the login environment (Homebrew `PATH`, her CLI auths) plus opted-in secrets.
- **No restrictions in clean runs**: file tools accept absolute paths anywhere on the machine (relative
  paths resolve inside the workspace); `bash` can reach the LAN and the internet; no concurrency cap, no
  per-workspace quota. Kept: output caps and timeouts on foreground commands (so a tool result stays
  readable), the background-shell registry (process groups; re-attach or mark lost on restart), watches,
  idle/terminal cleanup of *processes*, the 30-day sweep of finished workstreams' workspace dirs, and a
  **low-disk alarm** (free space on the mini's volume < 5 GB → iMessage Tony + pause new workspace work
  until ≥ 8 GB).
- **Taint confinement (D6)**: when `agent.taintConfinement` is on and the run is tainted, every command is
  wrapped in `sandbox-exec -f <generated profile>`: `(deny network*)`, `(deny file-write*)` except the
  workspace dir and a per-run tmp dir; no secrets in env; background shells/watches refused. Each
  confinement records `sandbox:confined` activity and shows a "confined (tainted run)" chip on the tool
  part. Workspace taint (cycle 82 persistent semantics) and "Re-enable network" unchanged.
- The Docker runtime, `deploy/sandbox/*`, and the `mymind-sandbox` network/iptables provisioning are
  removed. Host `exec` + the `admin` toolset are removed; the system prompt's SHELL block describes the
  workspace as Bridget's own Mac: full machine, LAN and internet, her own logins, workspaces as her
  default storage.

## 4. Search
`search/providers/searxng.ts` and SearXNG settings removed; `resolve.ts` returns Brave; the Settings →
Search tab shows Brave only (key status). A per-process token bucket (default 1 req/s, burst 3,
setting `search.brave.qps`) + retry on 429 with backoff; `research_web` fan-outs share it. Eval web
fixtures unaffected (fake world).

## 5. Deploy + operations
- `deploy/macmini/`: launchd plists (`com.mymind.web`, `com.mymind.worker`), `provision-macmini.sh`
  (idempotent: dirs, plists, Homebrew deps check, Hermes retirement guard), `release.sh`
  (stage/activate/rollback for web `.output` and worker, mirroring `worker-release.sh`).
- `deploy.yml`: build job runs in LXC 114 (as today); deploy job: rsync artifacts to the mini, run
  `db:migrate` (from LXC 114 against `.80`, or on the mini with the shipped migrations), cancel running
  evals first, activate + `launchctl kickstart -k`, health gates (`/api/health`, worker heartbeat).
- Logs: `~/Library/Logs/mymind/{web,worker}.log` with rotation (newsyslog). The `prod-deploy` skill is
  rewritten for the mini (+ the LXC build box).
- Memory: only MyMind's own processes are capped (web ≤ 1.5 GB, worker ≤ 2 GB `--max-old-space-size`) so
  heavy agent work can't OOM-kill the app; agent commands are uncapped.

## 6. Cutover runbook (executed by the controller, Tony informed)
1. Preflight on the mini: provision, ship the release, health-check against an **empty** test DB is not
   possible on `.80` (shared) → verify the app boots with `.80` after restore only.
2. Window: stop `mymind` + `mymind-worker` in LXC 114; `pg_dump -Fc --no-owner --no-acl` from
   `mymind-db`; `pg_restore` into `.80`/`bridget`; verify row counts table by table vs the source.
3. rsync uploads → mini; start mini services; `/api/health` 200; MCP round trip; a chat turn; a
   workstream with a workspace command; Brave search; iMessage send/receive via BlueBubbles.
4. Retarget Pangolin to `192.168.2.35:3000`; external `/api/health`.
5. Keep LXC 114's DB container + data for 7 days (app units disabled). Rollback = start LXC 114 units +
   Pangolin back.

## 7. Testing
Unit/DB: host runtime (exec, output caps, timeouts, background shells, watches, relative vs absolute
paths, low-disk alarm), `sandbox-exec` profile generation + a darwin-only integration test proving a
tainted command has no network and cannot write outside the workspace while a clean one can reach the LAN
and write anywhere; the `agent.taintConfinement` switch; Brave limiter +
429 retry; evals run green on the host runtime (bridget-core on dev). Browser: Files/Shells tabs against
host workspaces; Settings → Search Brave-only. Prod acceptance: cutover checklist (§6) + bridget-core on
prod ≥ the 2026-10-13 baseline (20/21 → now 22/23 with the new edit cases).

## 8. Out of scope
GPU/local models on the mini, multi-host workers, the optimizer (6b), retiring LXC 114 entirely (after
the 7-day rollback window, a follow-up).
