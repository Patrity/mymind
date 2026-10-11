---
title: Agent worker + workstreams — runs move to apps/worker over a Postgres bus; long-running workstreams (cycle 81, harness step 2)
cycle: 81
date: 2026-10-11
status: built  # → deployed after CD + prod acceptance
branch: feat/worker (worktree .claude/worktrees/feat+worker, base 3e0c5e9)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-10-11-worker-and-workstreams-design.md
plans:
  - ../superpowers/plans/2026-10-11-worker-and-workstreams.md
wiki:
  - ../wiki/agent-runtime.md
  - ../wiki/workstreams.md
  - ../wiki/core-package.md
  - ../wiki/agent.md
migrations:
  - 0068 run_events, worker_commands, worker_heartbeat
  - 0069 ns (bus namespace) on all three
  - 0070 worker_heartbeat.status
  - 0071 workstreams table, agent_runs.kind, one active segment per workstream
new_units: [mymind-worker]
next: harness step 3 — sandboxed workspace (file tools, background shells, watch)
---

# Agent worker + workstreams (cycle 81)

Every agent run now executes in `apps/worker` (systemd `mymind-worker`, esbuild bundle run from the
preserved release dir `/opt/mymind/.worker`, stage/activate/rollback via `deploy/worker-release.sh`).
The web (Nuxt) never executes a run: it streams, does STT/TTS, renders approvals, and sends commands.
Current-state reference: [wiki/agent-runtime.md](../wiki/agent-runtime.md), [wiki/workstreams.md](../wiki/workstreams.md).

## What shipped
- **Bus (core `lib/bus`):** `run_events` append-only log (coalesced deltas, per-run seq, retry, namespaced) + `NOTIFY` pointers; `worker_commands` (kick, abort, approval-decision, undo, presence, invalidate, workstream-control, imessage-health; per-thread ordering with abort/decision bypass; claim + timeout + prune); cross-process live updates with resync; half-open listener detection; heartbeat (worker-offline banner).
- **Worker:** owns claiming/execution, the 5s tick (recovery, jobs, outbox, iMessage catch-up), agent scheduled tasks, observability flush; graceful drain; crash traps; boot recovery retry; shared env→CoreConfig mapper (all plain keys paired with `NUXT_` twins).
- **Streaming:** web relays bus frames per socket with replay by seq; client auto-reconnects (jitter, "Reconnecting…", 401 → /login) and resumes; open approval cards re-sent on reconnect; TTS synthesized in the web for the origin socket.
- **Across processes:** approvals (full card on the bus, decision command, chat 120s auto-deny, cycle-79 pins intact), Stop (expiring abort), `/clear` (epoch only after a real settled ack), undo (local first, then worker), presence, settings invalidation.
- **Workstreams:** segmented runs (40 steps), budgets (400 steps / 2h active wall clock; resume +40/+30m), states queued/running/attention/paused/done/failed/cancelled, `start_workstream` (session-only start/resume; headless → /review), `finish_workstream`, `ask_tony` (iMessage reply routed when exactly one is waiting; else `answer_workstream`), approvals wait without timeout, no approval survives a restart (fresh card), idle detection, cap of 3 active, nudges capped at 3, retention prune, `/workstreams` list + live detail UI.
- Deleted the unused legacy `/api/agent/chat`.

## Evidence
- Counts: base 3526/898-era → final test 3709/1, test:db 959; typecheck, build, worker build + stage ("all externals load").
- Several hundred mutation checks across 6 tasks + fix rounds (each red when broken).
- Browser: chat/tool turn parity, voice, reload + web restart mid-turn (244/244 unique frames, no reload), approvals approve/deny/re-sent after restart, Stop, `/clear` ordering, undo, settings, workstreams from UI and chat, approval + ask_tony + steer + cancel + resume + paused + cap + offline banner.
- Pre-deploy prod checks: env pairing changes nothing for the web; disk 12 GB free, 6 GB RAM available.

## Known limits / follow-ups
- Approvals pending across a restart need a fresh click (by design).
- Audio doesn't resume after a reconnect (text does).
- Subagent steps/cost not counted in workstream budgets; wall clock is active time only.
- Rollback below cycle 81: `systemctl disable --now mymind-worker` FIRST (DEPLOYMENT.md §21a); one level, no migration revert.
- Deferred minors: see the SDD ledger (final-review M1–M4, M6, M7 and per-task minors).
