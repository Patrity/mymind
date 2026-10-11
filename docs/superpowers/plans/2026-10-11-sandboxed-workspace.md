# Sandboxed Workspace Implementation Plan (cycle 82, harness step 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridget works in a per-workspace Docker sandbox with file, shell, background and watch tools, no approvals inside the box, no route to the app/secrets/LAN, and no network at all in tainted runs.

**Architecture:** core `lib/sandbox` (docker CLI runner, lifecycle, quota) used by the worker; a `workspaces` table; a `workspace` toolset; host `exec` moved to an `admin` toolset; provisioning installs the sandbox network + firewall rules and CD builds the image.

**Tech Stack:** Docker CLI, iptables `DOCKER-USER`, `@mymind/core`, worker, drizzle, Nuxt UI, vitest, playwright-cli.

**Spec:** `docs/superpowers/specs/2026-10-11-sandboxed-workspace-design.md`

## Global Constraints

- Sandbox flags exactly per spec §2 (user 10001, cap-drop ALL, no-new-privileges, pids 512, memory 2g, cpus 1.5, read-only rootfs + tmpfs /tmp and /home/agent, only the workspace mounted, network `mymind-sandbox`).
- All file operations happen inside the container — never resolve workspace paths on the host.
- Tainted runs: commands in a one-off `--network none` container; background shells refused.
- No approvals for workspace tools; not on `/api/mcp`; results marked untrusted.
- Docker-backed tests run only when Docker is available (skip cleanly otherwise) and clean up every container/dir they create (label `mymind.test=<runId>`).
- Gates: typecheck, test, test:db, build + worker stage. Conventional commits, no attribution trailers. Commit first, then mutate, restore with `git checkout`. Never `git stash`. Dev DB shared. Kill only your own processes.

## Review Focus
1. **Sandbox escape** — mounts, symlinks, docker socket, capabilities, env leakage, reaching Postgres/SearXNG/LAN/host gateway.
2. **Tainted exfiltration** — any path that gives a tainted run network (background shells, watch, reused container, export).
3. **Resource exhaustion on a 2-CPU/8 GB box** — fork bombs, memory, disk, runaway background shells, orphan containers.
4. **Lifecycle races** — concurrent commands creating the container twice, idle stop during a command, worker restart mid-command.
5. **Deploy** — firewall rules idempotent and surviving reboot, image build cost on the box, disk.

---

### Task 1: Sandbox runtime + workspaces table
Files: `deploy/sandbox/Dockerfile`, `packages/core/src/lib/sandbox/{docker,manager,quota,network}.ts` + tests, schema/migration `workspaces`, provisioning helpers (`deploy/sandbox/install-network.sh`: network + DOCKER-USER rules, idempotent, persisted via a systemd oneshot), worker boot reconcile + idle-stop + quota tick.
- [ ] Tests (Docker-gated): container runs as uid 10001 with the exact flags; `/opt/mymind` and app env absent; `cat /proc/1/environ` shows only allowed vars; Postgres on the host loopback and an RFC1918 address unreachable from the sandbox (dev: assert the rule set produced by `network.ts` and test against a local blackhole); internet reachable (skip if offline); tainted exec has no network; symlink to an absolute host path resolves inside the container only; fork bomb hits pids limit without affecting the host; quota refusal; idle stop; reconcile removes labelled orphans; concurrent `ensureContainer` creates exactly one.
- [ ] Commit `feat(sandbox): docker sandbox runtime, workspaces, network isolation`.

### Task 2: Workspace toolset
Files: `packages/core/src/lib/agent/tools/workspace.ts` + tests (fake runner + Docker-gated integration), toolsets registry (`workspace`, `admin`), move `exec` to `admin`, prompt SHELL block, gate classes (spec §4), MCP exclusion, workstreams pre-load `workspace`, `watch` integration with workstreams (wake on condition; chat → note), background shell registry (per workspace, survives worker restart by re-attaching or marking lost), export/import document tools.
- [ ] Tests per tool incl. limits/caps, edit uniqueness, binary detection, background → output → kill, watch until-exit-0 and until-regex and timeout, tainted run: `bash` network-off + `run_in_background` refused + `watch` refused (or network-off), export headless → proposal.
- [ ] Commit `feat(workspace): file, shell, background and watch tools in the sandbox`.

### Task 3: Secrets opt-in + UI
Files: `exec_secrets` `sandbox` flag (+ Settings → Secrets toggle), injection into sandbox env (never tainted), workstream detail Files + Shells tabs, chat "Workspace" view (home workspace), API routes (session-only for writes) `GET /api/workspaces/:id/files`, `GET …/file?path`, `GET …/download`, `GET …/shells`, `POST …/shells/:id/kill` — all reading via the sandbox runner (no host path resolution).
- [ ] Browser-validate in this task: a workstream writes a script, runs it, starts a background job, watches it, finishes; Files shows the tree + viewer; Shells shows and kills; toggle a secret to sandbox and see it in `env` in a sandbox command (then untoggle).
- [ ] Commit `feat(workspace): sandbox secrets opt-in, files and shells UI`.

### Task 4 (controller): final review, docs, deploy
- [ ] Final review → fix wave → re-review; wiki `workspace.md` (+ agent.md toolsets, core-package, DEPLOYMENT, prod-deploy skill); handover; roadmap.
- [ ] Confirm with Tony → deploy (image build, network + rules, dirs) → prod acceptance: a workstream runs code in the sandbox; from inside the sandbox `curl 127.0.0.1:5432`, the LXC IP, a LAN IP all fail; a tainted run has no network.
