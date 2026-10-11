---
title: "Sandboxed workspace — per-workspace Docker sandbox, file/shell/watch tools, taint-aware network (cycle 82, harness step 3)"
cycle: 82
date: 2026-10-11
status: spec
supersedes: null
builds_on: 2026-10-11-worker-and-workstreams-design.md
---

# Sandboxed workspace (cycle 82 — harness step 3)

Today `exec` runs as **root in LXC 114** (full access to `/opt/mymind`, `.env.native`, the DB).
This step gives Bridget a real workspace — files, shells, background processes, polling — inside a
Docker sandbox per workspace, so she can work freely without approvals and without being able to
touch the app, its secrets or the LAN. Host `exec` moves to an on-demand `admin` toolset.

## 1. Decisions (brainstorm 2026-10-11)

| # | Decision | Rejected |
|---|---|---|
| D1 | **Docker sandbox container per workspace** (`mymind-sandbox` image, unprivileged user, only the workspace dir mounted, no docker socket/app/env, limits 1.5 CPU / 2 GB / 512 pids) — portable to the Mac mini | host unix user; bubblewrap/Landlock (Linux-only); status quo |
| D2 | One workspace per workstream + one persistent chat "home" workspace; files kept until the workstream finishes + 30 days (amended — §3) | ephemeral per run |
| D3 | `workspace` toolset: `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `diff`, `bash` (+ background), `bash_output`, `kill_shell`, `watch`, `export_to_document`, `import_document` | — |
| D4 | **No approvals inside the sandbox** | approval per command |
| D5 | Sandbox network: internet yes; no LAN/RFC1918/link-local, no LXC loopback services. **Tainted run → commands run with no network** | approval after taint |
| D6 | Secrets: none by default; per-secret "sandbox" opt-in | inherit exec secrets |
| D7 | Host `exec` → on-demand `admin` toolset, unchanged allowlist/approval semantics | delete exec |

## 2. Sandbox runtime (core `lib/sandbox`, worker-side)

- **Image** `mymind-sandbox:<sha>` from `deploy/sandbox/Dockerfile` (Debian slim; git, python3 + uv,
  node + pnpm, ripgrep, jq, curl, build-essential; user `agent` uid 10001; workdir `/workspace`).
- **Workspace dir** `/opt/mymind/.workspaces/<workspaceId>` (owned by uid 10001, mode 0700), bind-mounted
  read-write at `/workspace`. Nothing else is mounted. Container flags: `--user 10001`,
  `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--memory 2g`,
  `--cpus 1.5`, `--read-only` root fs + tmpfs `/tmp` and `/home/agent`, network `mymind-sandbox`
  (a user-defined bridge whose egress to RFC1918, link-local, CGNAT and the docker host gateway is
  dropped via `DOCKER-USER` iptables rules installed by provisioning).
- **Lifecycle:** `ensureContainer(workspaceId)` (create/start, label `mymind.workspace=<id>`),
  idle stop after 15 min without commands, removed (not the dir) on workspace deletion; reconcile on
  worker boot (orphan containers removed).
- **Exec:** `docker exec` with timeout (default 120s, max 600s), output cap (64 KB, tail-kept), env =
  `HOME`, `PATH`, `LANG` + opted-in secrets only.
- **Tainted runs:** commands run in a one-off `docker run --rm --network none` container with the same
  mount and limits (background shells refused while tainted).
- **Quota:** soft quota 5 GB per workspace — checked before writes and every 60s for running
  workspaces; over quota → writes refused and background shells killed, with a clear tool error.
- **Path safety:** all file tools execute **inside the container** (no host-side path resolution),
  so symlinks inside the workspace can't reach the host.
- **Docker access:** the worker shells out to the `docker` CLI (root in the LXC); dev on macOS uses
  Docker Desktop/colima. If Docker is unavailable, workspace tools return a clear error.

## 3. Workspaces model

`workspaces` table: `id`, `kind` (`workstream`|`home`), `workstream_id null`, `container_id null`,
`state` (`stopped`|`running`), `bytes_used`, `last_used_at`, `created_at`, `deleted_at`.
A workstream gets its workspace at start; chat runs use the single `home` workspace. Deleting a
workstream schedules its workspace for deletion after 30 days (daily sweep).

> **Amendment (2026-10-11, cycle 82 final review I7):** no code path deletes a workstream (cycle 81
> never built one), so "deleted + 30 days" could never fire and every workstream workspace was kept
> forever. The deletion clock now starts at the workstream's **terminal state**: the daily sweep
> removes the workspace (container, files, row) 30 days after its workstream's `finished_at`
> (done / failed / cancelled). A resumed workstream clears `finished_at`, so it is not swept. A
> workstream deleted outright (none today) still starts the clock via `deleted_at`. When the
> workstream ends, its background shells are killed, its watches cancelled and its container
> stopped at once (I2) — only the files wait out the 30 days.

## 4. Tools (`workspace` toolset; on demand for chat, pre-loaded for workstreams)

| tool | behaviour | kind | headless |
|---|---|---|---|
| `read_file({path, offset?, limit?})` | text with line numbers, ≤ 2000 lines, binary detection | read | run |
| `write_file({path, content})` | creates dirs | create | run |
| `edit_file({path, old_string, new_string, replace_all?})` | exact replace; error if not unique | create | run |
| `list_files({glob?, path?})` | ≤ 500 entries | read | run |
| `grep({pattern, path?, glob?})` | ripgrep, ≤ 200 matches | read | run |
| `diff({path?})` | `git diff` (inits git on first use) | read | run |
| `bash({command, timeout?, run_in_background?})` | foreground result or `{shellId}` | create | run |
| `bash_output({shellId})` / `kill_shell({shellId})` | incremental output / stop | read / create | run |
| `watch({command, until, intervalSec, timeoutMin})` | poll in sandbox; `until` = exit code 0 or a regex on output; wakes the workstream (or notifies chat) when met/timeout | create | run |
| `export_to_document({path, docPath})` / `import_document({docId, path})` | workspace ↔ MyMind documents | create | propose / run |

All workspace tool results are untrusted data. `bash` is **not** `outbound` (network is governed by
D5); `export_to_document` writes into Tony's corpus → headless **propose**. Not exposed on `/api/mcp`.

## 5. Admin toolset
Host `exec` moves from core to an on-demand `admin` toolset (directory line: "host operations on the
MyMind server — DB, services, logs; prefer the workspace for everything else"). Behaviour unchanged.
The system prompt's SHELL block points to the workspace by default.

## 6. Secrets
`exec_secrets` entries gain `sandbox: boolean` (default false); Settings → Secrets shows a toggle.
Opted-in secrets are injected into sandbox commands' env; never into tainted runs.

## 7. UI
Workstream detail gains **Files** (tree, viewer — code/markdown via the hardened renderer, download)
and **Shells** (running background shells, output tail, Kill). Chat gets a "Workspace" link in the
agent header opening the home workspace view.

## 8. Testing
Sandbox manager against real Docker in a DB/integration suite (skipped when Docker is absent):
isolation (no `/opt/mymind`, no env secrets, cannot reach Postgres/LAN, can reach the internet —
or a public test endpoint), limits (pids/memory kill), tainted → `--network none`, symlink escape
attempt fails, quota, idle stop, boot reconcile. Tool unit tests with a fake runner. Browser: Files
tab, Shells, a workstream that writes + runs a script + watches a background job.

## 9. Deploy
CD builds the sandbox image on the box; provisioning creates the `mymind-sandbox` network, installs
the `DOCKER-USER` drop rules idempotently, creates `/opt/mymind/.workspaces`. Disk check first.

## 10. Out of scope
Coordinator (step 4), judge (step 5), GPU, per-command network allowlists, multiple concurrent
workspaces per workstream.
