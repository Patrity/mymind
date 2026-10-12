---
title: Workstreams (long-running background agent work)
status: built
cycle: 81 (workspace integration: cycle 82)
updated: 2026-10-11
mymind_id: a5fa582b-9998-41b3-a9b3-53a41c8a0642
mymind_hash: e79151b4f4b107beaa5ff40ce85ad85f516ad94367926d064254c937b6ffb751
---

# Workstreams

A **workstream** is Bridget's long-running, budgeted background work on one goal. It runs in
**segments** on its own thread (titled `⚙ <goal>`), executed by the agent worker like any other run.
It can pause to ask Tony a question or to get an approval, and it ends with a summary posted to the
chat it was started from.

Spec: [`2026-10-11-worker-and-workstreams-design.md`](../superpowers/specs/2026-10-11-worker-and-workstreams-design.md) §5 ·
Related: [agent-runtime.md](agent-runtime.md) (runs, the worker, the bus), [channels.md](channels.md) (iMessage),
[workspace.md](workspace.md) (cycle 82: the sandboxed workspace every workstream gets).

The code is the source of truth:
- `packages/core/src/lib/agent/workstreams/`: `loop.ts` is the state machine; `store.ts`,
  `notify.ts`, `prompt.ts` and `cost.ts` support it.
- `packages/core/src/lib/agent/tools/workstreams.ts` holds the tools.
- `packages/core/src/shared/types/workstreams.ts` holds the shapes and constants.
- `server/api/workstreams/`, `app/pages/workstreams/` and `app/lib/workstreams/display.ts` are the API and UI.

## Model

- Table `workstreams` (migration 0068–0071, additive). Its columns: `conversation_id` (its own
  thread), `origin_conversation_id`, `goal`, `state`, `toolsets`, `budget`, `used`, `attention`,
  `summary`, `failure_reason`, `failures`, `last_outcome`, `cancel_requested`, `current_run_id`,
  and timestamps.
- A **segment** is one `agent_runs` row with `kind='workstream'` and profile `interactive`, on the
  workstream's thread. It has up to **40 model steps** (`SEGMENT_MAX_STEPS`) over the thread's
  persisted history. A unique index allows at most one queued or running segment per workstream.

## States

| State | Meaning | Counts toward the cap | iMessage answer routing | Nudged |
|---|---|---|---|---|
| `queued` | created; first segment not claimed yet | yes | — | — |
| `running` | a segment is executing, or the next one is queued | yes | — | — |
| `attention` + `{kind:'question'}` | `ask_tony` | yes | **yes** (when it is the only one) | yes, ≤ 3 |
| `attention` + `{kind:'approval'}` | a tool call waits on Tony's approval card | yes | no | yes, ≤ 3 |
| `paused` + `{kind:'paused', text}` | Tony pressed **Stop** in its thread, or **two idle segments** in a row | yes | **no** | **no** |
| `done` | `finish_workstream` | no | — | — |
| `failed` | budget used up (after a final summary step), or 3 consecutive failed segments | no | — | — |
| `cancelled` | Cancel | no | — | — |

The `paused` state comes from the final review's I3. Stop and "no progress" are **not
questions**. Before this state existed, a stopped workstream sat in attention: it was nudged every
2 h all night, and it captured Tony's next unrelated iMessage as its "answer". A paused workstream
is resumed by any of:
- **Resume** in the UI;
- a message typed into its thread;
- Bridget's `answer_workstream` in chat, when Tony asks.

When it pauses for being idle, Tony is told **once** (an origin-chat note, and a text when he is
away). Stop tells nobody, because it was his own act.

## The loop (`onSegmentFinished`, after the segment's run finishes)

| How the segment ended | Next |
|---|---|
| `finish_workstream(summary)` | `done`. The summary and a link are posted to the origin chat, and Tony is texted when away. |
| `ask_tony(question)` | `attention {question}`, notified. The next segment starts on his reply. |
| cancel requested | `cancelled` (the segment stops after its current step). |
| budget used up | One final **tool-free summary step** (its own 10 min cap), then `failed`, with the reason and the summary kept. |
| run failed | Retried. The 3rd consecutive failure (including a transition that throws) → `failed`. |
| aborted by Stop | `paused` (any words he sent meanwhile start the next segment instead). |
| no tool call and no finish, twice in a row | `paused`, Tony told once. A first idle segment just gets a nudge prompt. |
| otherwise | The next segment is queued (`segment:continue`). |

- **Crash or restart mid-segment.** Recovery re-enqueues the segment from the persisted thread
  (`segment:restarted`). A first interruption is free. One that follows another interruption counts
  toward the failure streak.
- **Drain (SIGTERM).** A running segment yields after its current step and its successor is queued
  for the next worker.
- **Stalled sweep.** A `queued` or `running` workstream with no live segment gets its next one.
  This covers a crash between one segment finishing and the next being inserted.

## Budgets

- Defaults are **400 steps and 2 h**. Bounds: 1–2000 steps, 1 min–24 h (`BUDGET_LIMITS`). `used`
  is persisted **after every step**, and each segment's caps are what is *left*, so the budget holds
  across segments and restarts.
- **Wall clock is active time only.** It counts while a segment executes, minus time parked on an
  approval card. Waiting on Tony (attention or paused), queue waits and worker downtime never count.
  A hard timer aborts a step that overruns the wall budget by 60 s (`WALL_HARD_GRACE_MS`).
- **Steps** are the workstream's own model steps. The steps and cost of subagents it calls
  (`research_web`, `search_brain`) are **not counted**.
- **Cost** (`used.costUsd`) is tracked from `model_prices` (0 for an unpriced or local model). It is
  **not enforced**: there is no dollar cap.
- **Resume after the budget is used up** extends it by **+40 steps / +30 min** of active time
  (`RESUME_EXTENSION`, clamped to `BUDGET_LIMITS`). The UI says so on the button.

## Cap

At most **3 non-terminal workstreams** (`MAX_ACTIVE_WORKSTREAMS`). That means queued, running,
attention **and paused**. The check runs under an advisory lock on start, and on resuming a
failed or cancelled one. Resuming a paused workstream is not re-checked, because it already counts.
A start at the cap is refused with a readable error (HTTP 409 `cap`).

## Sandboxed workspace (cycle 82)

A workstream gets its own Docker sandbox at start (`ensureWorkstreamWorkspace`, created up front by
`startWorkstream`); the `workspace` toolset — files, `bash` (foreground/background), `watch`,
document import/export — is **pre-loaded** for every segment (`runner.ts`), unlike chat where it
loads on demand. A chat turn typed into a **finished** workstream's thread falls back to the shared
`home` workspace instead (`resolveWorkspace`'s terminal-state check). Full reference:
[workspace.md](workspace.md).

- **Watches park a workstream for free.** `watch` polls inside the sandbox; if a segment ends with a
  watch still armed and no other work queued, the workstream parks as `paused {waitingForWatch}` —
  using **no step budget** while it waits. The watch firing (or timing out) wakes it as a new
  `segment:watch` segment. A workstream's watches are capped at 10 over its lifetime and 48 h of
  cumulative armed wait; past either cap, `watch` refuses and pauses the workstream for Tony instead
  of waiting indefinitely (counts toward the attention/pause bookkeeping above, not a new state).
- **Terminal-state cleanup.** The instant a workstream reaches `done`/`failed`/`cancelled`, its
  workspace's background shells are killed, its watches cancelled quietly (nobody to notify), and its
  sandbox container stopped — immediately, not at the next tick. Only the **files** wait out
  workspace.md's 30-day sweep. A resumed workstream (its state leaves terminal again) is exempt from
  that sweep until it next finishes.

## Approvals

A workstream approval **waits with no timeout** (`attention {approval}`). The card shows in the
workstream's log **and** is mirrored into the origin chat. When Tony is away, an iMessage prompt
races the card; whichever answers first decides. **Approvals never carry across a restart** (C1
ruling). On restore, the next worker withdraws the old card (closed in every tab, its iMessage
prompt expired) and resumes the segment with a note that the action did **not** run. The model
re-issues the call, and Tony approves a **fresh** card rendered from live content. Cycle-79
nonce and taint pins are unchanged.

## Telling Tony

- `notifyTony`: an event row in the origin chat with the link, plus a text when he is **away**.
- **Nudges**: a workstream in `attention` is re-announced at most every **2 h**
  (`NUDGE_EVERY_MS`) and at most **3 times per attention episode** (`MAX_NUDGES`; a new question or
  card starts a new episode). It is never re-announced while `paused`.
- **iMessage answers** (`routeInboundAnswer`). An inbound iMessage while **exactly one** workstream
  waits on a **question** becomes its answer: its next segment's prompt, with origin
  `imessage:<chat>` kept. Main gets a short "answered ⚙ …" note. With none or several waiting, the
  text lands in main as an ordinary turn, and Bridget can pass it on with `answer_workstream`.
  Paused and approval-waiting workstreams never capture a text.

## Tools

| Tool | Who | Notes |
|---|---|---|
| `start_workstream({goal, toolsets?, budget?})` | Bridget (core toolset) | Not available inside a workstream. In a headless run it becomes a `/review` proposal. Cap of 3. Profile-only: **not on MCP**. |
| `finish_workstream({summary})` | workstream segments only | → `done` |
| `ask_tony({question})` | workstream segments only | → `attention {question}` |
| `answer_workstream({id, text})` | Bridget | Answers a **question** or resumes a **paused** workstream. Refused for running work or an approval card, and inside a workstream. `outbound` (gated after a Google read; a proposal when headless). |

## API and UI

| Route | Auth | Does |
|---|---|---|
| `GET /api/workstreams?state=&limit=` | session or token | list, newest first (`limit` clamped to 100) |
| `GET /api/workstreams/:id` | session or token | one DTO |
| `POST /api/workstreams` | **session only** | start (from the UI; no origin chat) |
| `POST /api/workstreams/:id/resume` | **session only** | resume a failed, cancelled, paused or attention one |
| `POST /api/workstreams/:id/cancel` | session or token | cancel |
| `POST /api/workstreams/:id/steer` `{text}` | **session only** | steer while running; answer a question; continue a paused one |

Start, resume and steer require a web session (final review I5, and re-review NEW-1 for steer).
This follows the `wake.post.ts` rule: the auth middleware also accepts API tokens, and a leaked
token must not be able to launch an unattended background run. A steer can answer a question or
continue a paused workstream, so it can restart work too. Only cancel stays token-capable.

Controls go to the worker as a `workstream-control` command, awaited for 10 s. A worker that does
not answer gives a visible 504.

The UI:
- **`/workstreams`** (nav item) lists the workstreams: state badge, goal, elapsed, steps, cost and origin.
- **`/workstreams/[id]`** shows one workstream:
  - the budget meter;
  - what it waits on (the question or approval text, or the **Paused** reason);
  - the summary;
  - Cancel and Resume;
  - a steer, answer or continue box;
  - its live step log from `run_events`, rendered with the same components as chat (hardened
    markdown, tool parts, approval cards, Undo).
- **Chat** shows a compact card for a workstream started from it. Its mirrored approval cards show
  as orphan cards (see [agent-runtime.md](agent-runtime.md#processes-and-the-bus-cycle-81)).
- Live updates use the `workstream` resource.

## Retention

A workstream segment's `run_events` (its step log) are kept **while the workstream exists**. Other
runs' events are pruned 7 days after they finish. There is no delete action for a workstream yet,
so finished workstreams keep their logs indefinitely (final review M4, open).
