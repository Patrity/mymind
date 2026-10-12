---
title: "Coordinator — workstreams that fan out to child workstreams, a `subagents` model class, budget-governed concurrency (cycle 83, harness step 4)"
cycle: 83
date: 2026-10-12
status: built  # see handover 2026-10-12-coordinator.md
supersedes: null
builds_on: 2026-10-11-sandboxed-workspace-design.md
---

# Coordinator (cycle 83 — harness step 4)

Steps 2–3 gave Bridget long-running workstreams and a sandbox. One workstream is still one thread of
work. This step lets a workstream **orchestrate**: split a goal, spawn child workstreams that run in
parallel (research fan-out, multi-part builds, long-running watches), wait for them, read, steer and
cancel them, and merge their results. Governance is by **budget and model capacity**, not headcount.
Modelled on Turnstone's coordinator (spawn / wait / inspect / steer / close + child events).

## 1. Decisions (brainstorm 2026-10-12)

| # | Decision | Rejected |
|---|---|---|
| D1 | Any workstream becomes a coordinator by loading the on-demand **`coordinator` toolset**; no separate kind | a dedicated coordinator kind (Turnstone) |
| D2 | **Depth 1**: children cannot spawn children (as Claude Code subagents) | unlimited nesting |
| D3 | **No headcount cap** on children; sanity limit 50 per spawn call. The **top-level 3-workstream cap is removed** | fixed per-coordinator/top-level caps |
| D4 | **Tree budget** is the runaway guard: the coordinator carves each child's budget out of its own; tree default **2000 steps / 8 h active**; child default 200 steps / 1 h | independent child budgets |
| D5 | Concurrency is governed by **per-model in-flight pools** (agent segments running at once against each model), excess queued FIFO | one global cap; unbounded |
| D6 | New AI usage **`subagents`**: an ordered, capability-described model list; the coordinator picks a model per child by label; default = first entry; empty → children use `reasoning` | per-child hard-coded model flags; a paid/free switch |
| D7 | Child workspace: **own** by default; `workspace: 'shared'` runs the child in the coordinator's workspace; `export_to_coordinator(paths)` hands files up | always shared |
| D8 | A child's `ask_tony` goes to its **coordinator** first, which answers or escalates; dangerous-tool **approvals always go to Tony**, labelled with the child | everything to Tony |
| D9 | Child output is untrusted; a **tainted child taints the coordinator's run when the coordinator reads its output** (same rule as tainted workspaces) | per-child isolation only |
| D10 | Chat Bridget starts a coordinator via `start_workstream({toolsets:['coordinator'], …})`; chat itself never fans out | chat as coordinator |
| D11 | UI: **Children** panel on workstream detail; children nested under parents on `/workstreams` | flat list |

> **Amendment 2026-10-12 (cycle 83 final fix wave, ruling I1) — D4.** The tree budget counts the **children's
> steps only**, summed (a live child reserves its step budget, an ended one holds what it used — the rest is
> refunded, as before). The coordinator's own budget is **not** inside the tree, and **wall time is not a tree
> dimension**: each child is bounded by its own `maxWallMs` (default 1 h, max per `BUDGET_LIMITS`), the
> coordinator by its own budget (parked time does not burn). `start_workstream` takes `treeBudget: { maxSteps }`
> (default **2000**, max **10 000**) when its toolsets include `coordinator`; a workstream that loads
> `coordinator` later gets the default. With defaults, ten 200-step children fit at once.

No paid API is in use; nothing here models cost in dollars.

## 2. Data model

`workstreams` gains:
- `parent_id uuid null` → `workstreams.id` (`ON DELETE SET NULL`), indexed. Non-null = child. A child's
  parent must have `parent_id IS NULL` (depth 1, enforced in code and by a check trigger or the spawn path).
- `model_label text null` — the `subagents` label the child runs on (null = default resolution).
- `workspace_mode text not null default 'own'` (`own` | `shared`).
- `tree_budget jsonb null` (coordinators only: `{ maxSteps, maxWallMs }`) and `tree_used jsonb null`
  (rolled up: own `used` + every child's `used`).
  *Amended (final fix wave I1):* `tree_budget` is `{ maxSteps }` — the children's steps; a `maxWallMs` on a
  row written earlier is ignored. `tree_used` is unchanged (a whole-tree roll-up for display).

A child gets its own thread (`⚙ <goal>`, as today) with `origin_conversation_id` = the coordinator's
thread. A child's budget is reserved from the parent's remaining tree budget at spawn time; unused
child budget returns to the pool when the child ends. *(Amended, I1: only its steps are reserved.)*

> **Amendment 2026-10-12 (cycle 83 Task 2 fix round 1, rulings I2 / C3 / S1).**
> - `is_child boolean not null default false` is set at spawn and never cleared. Every child rule (depth 1, no
>   `coordinator` toolset, notes to the coordinator instead of Tony, tree accounting) keys on it, **not** on
>   `parent_id`, which goes NULL when the coordinator's row is deleted. Deleting a coordinator (or its thread)
>   cancels its non-terminal children first; a child whose coordinator vanished is cancelled by the worker's
>   sweep — never promoted to top-level work.
> - `tainted boolean` (C3): a run of the workstream read mail/calendar/contacts; never cleared (D9).
> - `lifecycle_noted text` (S1): the last child lifecycle event written into the coordinator's thread. Those
>   notes (§5) are **state-only** (the child's goal + spawned/attention/paused/done/failed/cancelled, never its
>   output) and are never appended while a coordinator segment runs (that would fork its thread); child
>   output reaches the coordinator only through `wait_for_workstreams` / `read_workstream` results and the
>   wake report.

## 3. Model class `subagents` and concurrency pools

- `USAGES` gains **`subagents`**. `ModelDef` gains `description: string | null` (written for the
  orchestrator — "fast, long context, high concurrency: research, reading, summarizing") and
  `maxInFlight: number | null` (default 16). Settings → AI shows both, plus the `subagents`
  assignment list (ordered, as every usage).
- **Resolution for a child:** its `model_label`'s model, then the rest of `subagents` in order, then
  the `reasoning` chain (failover as today). Empty `subagents` → `reasoning`. Coordinators always run on
  `reasoning`.
- **Pools:** every agent segment (chat turns excluded — chat stays responsive) acquires a slot in its
  **primary model's** pool before it is claimed; size = that model's `maxInFlight`. Waiting segments
  stay `queued` in FIFO order. Failover during a segment does not re-acquire (bounded overshoot,
  acceptable). The pool is enforced in the worker's claim path (DB-backed so it survives restarts:
  count of `running` workstream segments per model).
- **Measured default:** the plan's first task ramps concurrent workstream segments against the live
  vLLM box (RTX PRO 6000) until per-stream tokens/s or time-to-first-token degrades, and sets the
  default `maxInFlight` just below that knee (recorded in the handover).

## 4. Coordinator toolset (`coordinator`, on demand; workstream runs only, top-level only)

| tool | behaviour | headless |
|---|---|---|
| `spawn_workstreams({ children: [{ goal, toolsets?, budget?, model?, workspace? }] })` | ≤ 50 per call; validates labels against `subagents`; reserves budget from the tree (refuses with a clear error when the tree can't cover it); returns ids | run |
| `wait_for_workstreams({ ids, until: 'all'\|'any', timeoutMin })` | **parks** the coordinator (no segment runs, no wall clock burns — same mechanism as `watch`); woken by child terminal/attention events or timeout; returns each child's state + summary | run |
| `read_workstream({ id, tail? })` | state, budget used, summary, last N log entries (untrusted; taints per D9) | run |
| `steer_workstream({ id, message })` | queues a steer into the child (existing steer path) | run |
| `answer_child({ id, answer })` | answers a child's pending `ask_tony` question | run |
| `cancel_workstreams({ ids \| 'all' })` | cancels children | run |
| `export_to_coordinator({ paths })` | (child-side, in the `workspace` toolset when the run is a child with an `own` workspace) copies files into the coordinator's workspace under `/workspace/from/<childId>/` | run |

Tool results that include child output carry the existing untrusted-data marking.

## 5. Behaviour

- **Child lifecycle events** (`spawned`, `attention`, `done`, `failed`, `cancelled`) are written to the
  coordinator's thread as event notes and wake a waiting coordinator.
- **`ask_tony` in a child** → child state `attention`; the coordinator is woken with the question.
  The coordinator answers (`answer_child`) or calls its own `ask_tony` (Tony sees both questions).
  If the coordinator is itself in `attention`/`paused`, the child's question also notifies Tony.
- **Approvals** in a child surface exactly as today (card in the child view, chat, iMessage), titled
  `<coordinator goal> › <child goal>`.
- **Cancel / budget exhaustion of the coordinator** cancels every non-terminal child. A child's
  failure never fails the coordinator; the coordinator decides.
- **Coordinator finish** with live children: `finish_workstream` is refused until children are
  terminal (or the coordinator cancels them).
- **Restart:** parked coordinators and their waits are persisted and re-armed at boot (as watches).
- **Taint:** D9; a `shared`-workspace child taints the shared workspace like any run (cycle 82 rules).
- **Sandboxes** are unchanged: containers start lazily on workspace tool use and compete for
  `SANDBOX_MAX_RUNNING` slots; research children that never use the workspace never start one.

> **Amendment 2026-10-12 (cycle 83 final fix wave, ruling I2) — D8 / iMessage routing.** Removing
> the top-level cap (D3) makes "several non-terminal workstreams each waiting on a question"
> routine rather than rare — including a coordinator in `attention {question}` with one of its
> children simultaneously **escalated** to Tony. The original D8 text ("the coordinator answers or
> escalates") did not say how an inbound iMessage reply picks among several open questions, and
> `routeInboundAnswer` returned `null` (dropping the reply into main chat) whenever more than one
> row qualified. Fixed by tagging: every outbound question text now carries a short `#k` handle —
> the smallest free integer among the currently open, routable questions (`attention.tag`,
> `tagQuestion`, assigned under one advisory lock, idempotent). A reply starting with `#k …` answers
> that question (the tag is stripped); an untagged reply answers the **most recently notified** open
> question; a `#k` matching no open question, with several waiting, is left for Bridget to route
> rather than guessed at. Tony's confirmation names which workstream got the reply and lists the
> others' tags when more than one was open. See [workstreams.md § `ask_tony` routing and
> escalation](../../wiki/workstreams.md#ask_tony-routing-and-escalation) for the shipped mechanics.

## 6. UI

- Workstream detail: **Children** panel — tree rows with state badge, goal, model label, steps/wall
  used vs reserved, Steer and Cancel; the coordinator's tree budget meter.
- `/workstreams`: children nested under their coordinator (collapsed by default).
- Settings → AI: `subagents` assignment list; per-model description + max in flight.

## 7. Testing

- Unit/DB: spawn validation (depth, labels, 50 limit, tree reservation + refund); pool acquire/queue
  FIFO and restart safety; wait park/wake on any/all/timeout; `ask_tony` routing + escalation; cancel
  cascade; finish refused with live children; taint propagation on `read_workstream`/`wait` results;
  model resolution + failover order; the removed top-level cap.
- Load: the vLLM ramp (plan task 1) recorded as data.
- Browser (playwright-cli): from chat, start a coordinator that fans out 4 research children on
  different topics and merges a report; Children panel live; steer one child; cancel one; a child's
  question answered by the coordinator; Settings → AI subagents list edited.

## 8. Deploy
Migration only (workstreams columns, ModelDef fields are JSON). No new services. Prod acceptance: a
real fan-out of ≥ 6 children on prod finishing with a merged summary; pool limits observed in
`agent_runs` concurrency.

## 9. Out of scope
Depth > 1, judge (step 5), eval/optimizer (step 6), Mac mini host move (step 7), cross-host workers,
dollar budgets.
