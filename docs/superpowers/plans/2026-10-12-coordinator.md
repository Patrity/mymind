# Coordinator Implementation Plan (cycle 83, harness step 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workstream can fan out to child workstreams (depth 1) that run in parallel on capability-described `subagents` models, governed by a tree budget and per-model in-flight pools, and merge their results.

**Architecture:** `subagents` usage + ModelDef `description`/`maxInFlight` in the AI registry; a DB-backed per-model pool in the worker's claim path; `workstreams.parent_id` + tree budget; a `coordinator` toolset whose `wait_for_workstreams` parks like `watch`; child events and `ask_tony` routed to the coordinator; Children UI.

**Tech Stack:** `@mymind/core` (agent/workstreams, ai/registry, runtime queue), worker, drizzle, Nuxt UI, vitest, playwright-cli.

**Spec:** `docs/superpowers/specs/2026-10-12-coordinator-design.md`

## Global Constraints

- Depth 1: a child (`parent_id` non-null) can never spawn; spawn limit 50 per call.
- Tree default `{ maxSteps: 2000, maxWallMs: 28_800_000 }`; child default `{ maxSteps: 200, maxWallMs: 3_600_000 }`; reservations come out of the parent's remaining tree budget and unused child budget is refunded at the child's terminal state.
- `maxInFlight` default 16; pools count **workstream segments only** (chat turns never wait on a pool).
- Child model resolution: label's model → rest of `subagents` in order → `reasoning` chain; empty `subagents` → `reasoning`; coordinators always `reasoning`.
- The top-level `MAX_ACTIVE_WORKSTREAMS` cap is removed.
- Approvals always reach Tony; child output is untrusted and taints the reading run when the child (or its workspace) is tainted.
- No paid-API or dollar concepts.
- Gates: typecheck, test, test:db, build + worker stage. Conventional commits, **no attribution trailers**. Commit first, then mutate, restore with `git checkout`. Never `git stash`. Dev DB shared — own `MYMIND_BUS_NS`, clean up rows. Kill only your own PIDs.

## Review Focus
1. **Runaway trees** — budget reservation/refund races (parallel spawns, child ending while parent spawns), budget leaks across restarts, a coordinator that can never finish.
2. **Pool correctness** — slots leaked on crash/abort/restart, FIFO starvation, chat accidentally pooled, failover double-counting.
3. **Park/wake** — `wait_for_workstreams` missed wake (child finished before the wait was armed), double resume, wake after cancel.
4. **Routing** — a child's `ask_tony` lost when the coordinator is paused/attention; Tony's reply in a child thread vs the coordinator's answer racing.
5. **Taint** — child output reaching the coordinator without the untrusted marking or taint propagation.

---

### Task 1: `subagents` model class + per-model pools
Files: `packages/core/src/lib/ai/registry/{types,schema,resolve}.ts` (+ tests), Settings → AI page (usage list + model description + max in flight), runtime claim path (`packages/core/src/lib/agent/runtime/*`, `workstreams/loop.ts`) for a DB-backed pool keyed by the segment's primary model id, `scripts/vllm-ramp.ts` (measure concurrent workstream-segment throughput against the dev `reasoning` model: 1,2,4,8,16,24,32 concurrent streams of a fixed prompt; record tokens/s per stream and TTFT p50/p95; print a table).
- [ ] Tests: `subagents` round-trips through schema/PUT; `description`/`maxInFlight` validated (1–256); resolution order (label → rest → reasoning; empty → reasoning; unknown label → error at spawn); pool: N+1th segment stays queued and is claimed FIFO when one ends; slot released on success/failure/abort/interrupt and recomputed from DB after a worker restart; chat turns never queued by a pool; failover mid-segment doesn't take a second slot.
- [ ] Run the ramp against the live rig; record the table in the task report; set the shipped default `maxInFlight` from the knee (keep 16 if the knee is above it).
- [ ] Browser-validate Settings → AI: add a model to `subagents`, edit description + max in flight, save, reload.
- [ ] Commit `feat(ai): subagents model class and per-model in-flight pools`.

### Task 2: Coordinator core
Files: migration (`workstreams.parent_id`, `model_label`, `workspace_mode`, `tree_budget`, `tree_used`), `shared/types/workstreams.ts`, `workstreams/{store,loop,prompt,notify}.ts`, `packages/core/src/lib/agent/tools/coordinator.ts` (+ tests), toolsets registry (`coordinator`, on demand, top-level workstream runs only), `export_to_coordinator` in the workspace toolset (child with `own` workspace only), removal of `MAX_ACTIVE_WORKSTREAMS`, prompt rules for coordinators (plan the split, pick models by description, wait instead of polling, merge, finish only when children are terminal) and for children (report via `finish_workstream`; `ask_tony` reaches the coordinator).
- [ ] Tests: spawn validation (depth, 50, labels, tree reservation incl. two parallel spawns racing, refund on child end); `wait_for_workstreams` all/any/timeout incl. "child already terminal before wait" and restart re-arm; `read_workstream` marking + taint propagation; `steer_workstream`; `answer_child` resumes the child; child `ask_tony` → coordinator woken; escalation when coordinator is paused/attention notifies Tony; approvals titled `<coordinator> › <child>`; coordinator cancel/budget exhaustion cascades; `finish_workstream` refused with live children; child failure doesn't fail the coordinator; `shared` workspace child runs in the coordinator's workspace; `export_to_coordinator` copies into `/workspace/from/<childId>/` inside the sandbox (Docker-gated); top-level cap gone.
- [ ] Commit `feat(workstreams): coordinator toolset, child workstreams, tree budgets`.

### Task 3: UI + end-to-end
Files: workstream detail Children panel (tree rows: state, goal, model label, used vs reserved, Steer, Cancel; tree budget meter), `/workstreams` nesting, live updates via the `workstream` resource, API routes for steer/cancel of a child (session-only, reuse existing control routes if they already cover it).
- [ ] Browser-validate with a real model: from chat, start a coordinator that fans out ≥ 4 research children on different topics and merges a report; Children panel updates live; steer one child; cancel one; a child's question answered by the coordinator; nested list on `/workstreams`. Screenshots read.
- [ ] Commit `feat(workstreams): children panel and nested workstream list`.

### Task 4 (controller): final review, docs, deploy
- [ ] Final whole-branch review → fix wave → re-review; wiki (`workstreams.md` coordinator section, `agent.md` toolsets, `ai-providers.md` subagents + pools); handover; roadmap.
- [ ] Confirm with Tony → deploy → prod acceptance: a real fan-out of ≥ 6 children finishing with a merged summary; pool limits visible in concurrent `agent_runs`.
