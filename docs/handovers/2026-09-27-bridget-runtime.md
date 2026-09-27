---
title: Bridget runtime — server-owned turns, a main thread, a turn queue, one headless wake()
cycle: 73
date: 2026-09-27
status: built
branch: feat/bridget-runtime
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-09-27-bridget-runtime-design.md
plans:
  - ../superpowers/plans/2026-09-27-bridget-runtime.md
wiki:
  - ../wiki/agent-runtime.md
  - ../wiki/agent-context.md
  - ../wiki/voice-agent.md
  - ../wiki/agent.md
migrations:
  - 0054 conversations.kind / summarized_through; conversation_messages.origin; agent_runs; agent_inbox; review_queue_one_pending_per_target excludes agent-action
migrations_run_on_prod: false
mymind_task: 8fdc0fe7
---

# Cycle 73: the Bridget runtime

This is the first of the always-on Bridget cycles (73 runtime → 74 wake layer → 75 outbound
channel → 76 self-improvement). A turn is no longer something that happens inside a browser
WebSocket. It is an `agent_runs` row, claimed by a worker in the Nitro process, executed by
`server/lib/agent/runtime/runner.ts`, and fanned out to whoever is watching. Closing the tab
unsubscribes. The reply keeps going and persists.

**Status:** the branch is built and every gate is green. All six browser acceptance scenarios
pass. It is **not merged and not deployed**. Migration 0054 is applied to the shared dev DB only.

How it works today: [`docs/wiki/agent-runtime.md`](../wiki/agent-runtime.md). This handover
covers what shipped, what the build changed relative to the spec, and what is left open.

## What shipped

- **`server/lib/agent/runtime/`** contains `runner` (the old `ws.ts` turn body, moved verbatim),
  `queue`, `runs`, `sessions`, `stream`, `inbox`, `steer`, `wake`, `gate`, `replay`, `approvals`,
  `aborts`, `recover`, `summarize`, `history`, `suppress`, `event-text` and `flag`. The plugin
  `server/plugins/agent-runtime.ts` reads the flag, runs boot recovery, then starts the worker.
- **`ws.ts` is a thin subscriber** (313 lines, down from 463 when it was the whole turn). Its
  header comment is the authoritative protocol.
- **Main thread.** `conversations.kind='main'`, at most one, enforced by an index. `/agent` opens
  it by default through `GET /api/agent/main`, and the thread rail pins it as "Bridget".
- **Event rows** (`role='event'`, `origin`) render as dividers: `woken · <reason>`,
  `review · approved`, `runtime`. In model history they become a plain sentence.
- **Steering.** A message sent while an interactive run is running is spliced into that run at
  the next step boundary, and persisted as a user row between the question and the reply.
- **`wake()`** is backed by `POST /api/admin/agent/wake` (session only) and the `/wake` composer
  command. It runs headless: text is not streamed live, a `NO_REPLY` reply is suppressed, there
  is a 5 min wall clock, and one headless run is in flight globally.
- **Headless gate.** Read and append tools run. Mutating and destructive tools become
  `agent-action` review proposals. `exec` is excluded, and subagents refuse non-read tools.
- **`/review` agent-action cards.** Approving replays the stored call deterministically: claim,
  validate against the tool's current schema, run the handler with span, undo and activity, then
  append an event row to the thread.
- **Bounded history.** The cycle-70 turn tier is wired (budget 20000). `conversations.summary`
  finally has a writer: an after-run fold plus the `*/10` `summarize-threads` idle sweep. There
  are two new fixed tiers, `recent-threads` (main) and `main-state` (side threads).
- **Runs drawer** on main (`GET /api/agent/runs`), live-invalidated by the `agentRun` resource.
- **UMAP yields between epochs** (`computeLayoutAsync`). The worst event-loop stall went from
  **9434 ms to 4582 ms**. The remainder is umap-js's synchronous kNN init (see Open).
- **`agent_runtime` rollback flag.** It is read at boot, so flipping it needs a restart. The
  legacy in-socket path is `server/lib/voice/ws-legacy.ts`.

## Gates

| Gate | Baseline (5dbe809) | Now |
|---|---|---|
| `pnpm test` | 233 files · 2119 pass · 1 skip | **246 files · 2303 pass · 1 skip** |
| `pnpm test:db` | 36 files · 306 pass | **46 files · 381 pass** |
| `pnpm typecheck` | clean | **clean** |
| `pnpm build` | ok | **ok** |

Every new test was mutation-checked by its task's implementer and reviewer (see the SDD ledger).

## Browser acceptance (playwright-cli, dev on :3073, 2026-09-27)

Every scenario asserted DOM text, fetched JSON or DB rows, never the model's wording.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Turn outlives the tab | **PASS** | I asked for 1–200 as words and closed the only `/agent` tab after "twenty-four" had streamed, while run `7f8df74e` was `running`. After 30 s I reopened `/agent`. The transcript held 200 word lines ending "two hundred", and so did the persisted row (3261 chars). `GET /api/agent/runs` showed `done`, 11283 ms. |
| 2 | Steer | **PASS** (see note) | The composer placeholder switched to "Add to what she's doing…" and Submit stayed enabled next to Stop. The optimistic bubble rendered. An `agent_inbox` row was created 0.7 s before it was consumed. There was **one** run (`0924a256`), and the persisted chain was question → "actually make it vegetables" (user) → reply, in that order in the DOM after reload. |
| 3 | Wake with nobody watching | **PASS** | With no `/agent` tab open (the only tab was on `/tasks`), `accept-3` produced run `done` / `headless` / `wake`, an event row `wake:accept-3` and an assistant row. `/agent` showed the divider "woken · accept-3: Say exactly: the runtime works." followed by the reply. `accept-3b` produced run `done`, `suppressed: true`, `assistant_message_id: null`, and only the divider rendered. |
| 4 | Proposal round-trip | **PASS** | The task was created through the `/tasks` New task dialog. The `accept-4` wake produced review row `agent-action` / `pending` / `target_kind agent_run` with `{tool: edit_task, args: {id, status: completed}}`, and the task stayed in Todo with `completed_at` null. "Approve and run" on the `/review` card set the row to `approved`, moved the task to Completed, and showed the toast "Proposal approved · updated task · Undo". Main showed "review · approved: Approved: edit_task — updated task". |
| 5 | Summaries flow up | **PASS** (content); `used` delta inconclusive | A 7-turn scratch side thread was built through the UI, backdated 40 min, then `POST /_nitro/tasks/summarize-threads` returned `{summarized: 1}`. `summary`, `summarized_through` and the embedding were all set. The next main turn's `memory:assemble` logged `used: 14015`, and the debug context (a temporary `NUXT_DEBUG_CONTEXT` log, not committed) contained `Recent side threads (summaries):` with the thread's title. The tier is about 40 tokens, while `used` swung by hundreds across neighbouring main runs because retrieval count varied (12604 / 14187 / 13393 / 14015). So "used rises by the summary's size" can't be isolated from noise. The content assertion is the real evidence. |
| 6 | Two tabs, one turn, late join | **PASS** | Tab A started 1–500 as words. Tab B was reloaded mid-run and its reply text grew from 3176 to 5887 chars while the run was `running`. At the end both tabs had 500 lines ending "five hundred" with an identical content hash, 0 alerts and 0 console errors. |

**Scenario 2 note: steers drain only at a step boundary.** Two earlier attempts had a single tool
step, and the steer arrived during the final text step. In each case the steer was **not**
absorbed. At finish, `requeueUnconsumed` turned it into the next run: a second run answered
"vegetables", and the transcript read question → reply → steer → reply. That is the designed
fallback, since Tony's words are never dropped, but it is not a steer. A pure-text reply has no
step boundary to splice into, so "send a correction while she types" becomes a follow-up turn
unless the run is still making tool calls. This is worth knowing before cycle 74 builds on it.
The passing run forced four sequential `search_memories` calls.

**Test-harness notes** (added to `.claude/skills/browser-testing/SKILL.md`):
- The composer placeholder changes while busy, so select `textarea`, not the placeholder.
- A synthetic value-set plus `keydown Enter` inside `eval` submits the **previous** text
  (lag-by-one). Use real `fill` + `press`.

**Rows left behind on dev:** all 41 messages in the dev **main** thread
(`fbaac2d6-c8e6-49de-b063-79fdaa9b4a9f`, empty before this task) came from these scenarios,
together with its ~20 `agent_runs` rows and the approved `agent-action` review row `c363c56b`. The
ACCEPT-4 task and the ACCEPT5 side thread were deleted.

## Deviations from the spec (all ruled during the build; see the SDD ledger)

- **`agent_inbox.run_id` + `consumed_at`** replace `consumed_by_run`. A steer targets the run it
  was aimed at, and `pushSteer` inserts only while that run is still `running`, in one statement.
- **Unread steers are requeued on every terminal outcome and on recovery**, not only on abort.
  This overrides §4.4's abort-only wording, which contradicted its own "never silently dropped"
  rule.
- **Steers are persisted as user rows in the same append** as the turn:
  `[question, steer…, reply]`. The reply is last and is the leaf. `groupTurns` joins consecutive
  user rows into one turn, so a summary fold can't split that append; the rows share one
  `created_at`, and `sinceSummary` is `>`. Steer rows sit before the *whole* reply, which is
  coarser than where they were spliced live, and they carry no `origin`.
- **User messages steer only into interactive runs.** While a headless run is active on the
  thread, they queue behind it.
- **Fencing.** `touchRun` and `finishRun` only match `status='running'`. A run that loses its row
  aborts itself. This reverses the Task 2 "finishRun unguarded" ruling.
- **Orphan recovery runs on every 5 s worker tick** as well as at boot, excluding run ids this
  process is executing. Boot-only recovery would wedge a conversation after a restart under 60 s.
- **The protocol changed.** `load` selects the thread **without** subscribing, and `attach`
  subscribes and replays atomically. The client sends `attach` after committing the resumed
  transcript. Every hub JSON frame carries `cid`, and the client drops frames for threads it
  isn't viewing (including `createLeftThreads` for id-less threads after `new`). Turn tracking is
  split into `finished` (permanent, capped) and `discarded` (cleared on a thread switch).
- **`clear` awaits `abortActiveAndWait`** (10 s cap) after denying the thread's approvals, so
  rescued rows land before the epoch. The enqueue step of `submit` is serialised per socket.
- **The exec allowlist check lives in `approvalFor`**, so allowlisted commands run even after the
  originating socket is gone. An interactive run with no channel is **denied immediately**.
- **Voice runs** set `speak=true` and `modality='voice'`. STT happens in the socket before
  enqueue.
- **Wake runs withhold assistant text and reasoning frames live.** A subscriber sees the reply
  only through the `persisted` re-read, so a suppressed `NO_REPLY` is never glimpsed.
- **The admin wake endpoint requires a web session** (`requireSession`), not just the shared
  auth middleware, which also accepts `mm_` bearer tokens.
- **Headless gate table.** `APPEND_TOOLS` run, `PROPOSE_TOOLS` plus every `destructive` tool are
  proposed, `dangerous` tools are excluded, and an unclassified tool throws. `makeSubagentTool`
  rejects non-`read` tools because subagents bypass the gate.
- **Agent-action approval** claims `pending → applying` with a compare-and-set before replaying,
  then settles `applying → approved|failed`. It replays the handler directly rather than through
  `buildAiTools`, but restores `withSpan`, `registerUndo` and `publishActivity`, and returns
  `undoToken` to the UI. Approved actions have no tool-call message in the transcript, only the
  event row.
- **The `agent_runtime` flag is read at boot.** The WS `open` hook is synchronous, so flipping it
  needs a restart.
- **UMAP** yields between epochs instead of moving to a `worker_thread`, as a measure-first
  ruling.
- **Wake-produced assistant rows have `origin = null`.** Spec §4.2 said they would carry the wake
  origin; only the event row does. This was observed in scenario 3.

## Open / deferred

- **WS reconnect does not re-send `load`/`attach`.** After any reconnect (every deploy restart),
  the next message starts a **new** server-side thread and its reply drops out of view until
  reload. This was flagged at Task 13 as likely must-fix before merge.
- **An `agent-action` row stuck in `applying`** after a crash between claim and settle is
  invisible in `/review` and is not auto-reset, because the tool may have run. Follow-up: surface
  `applying` rows older than N minutes as "stuck — check the thread".
- **Residual UMAP kNN-init stall of about 4.5 s** during `compute-graph-layout` (hourly, and
  skipped unless the node count changed). Follow-up: a worker thread or a precomputed kNN.
- **The spec's "rationale" on agent-action cards has no data source.** Proposals carry
  `{tool, args, conversationId}` only.
- **Steers need a step boundary.** See the scenario 2 note. A correction sent during a text-only
  reply becomes a follow-up run.
- One-RTT client windows: submit → New → submit can pass unlearned stragglers, and `state` frames
  from before this cycle's `restAfterAbort` can race.
- Minors: the headless slot cap is per process (a count subquery with no lock). `isUniqueViolation`
  catches any 23505. The `pushSteer` EXISTS lacks `for share`. The `preAborted` set can grow, and
  there are stale `preAborted` ids for never-claimed runs. There are no live `agentRun` events for
  the queued/running states. `summarize-threads` lacks `recordJobSummary`, and the summary
  embedding write path is untested. A concurrent-approve loser toast says "approved". `claim()`
  doesn't `publishChange`, and a failed replay doesn't `publishActivity`. There is no branch-walk
  test on a steered turn (regenerate re-sends the steer). The wake run's
  `outcome.userMessageId` names the event row. `resolveSession('main')` is untested directly.
- There is no retry of interrupted runs (by design).

## Where cycle 74 starts

1. **Delete `server/lib/voice/ws-legacy.ts` and `server/lib/agent/runtime/flag.ts`** and the
   `runtimeEnabled()` branches in `ws.ts` and the plugin, once 73 has run in prod for a while.
2. Fix the **WS reconnect re-attach** if it isn't done before merge.
3. The heartbeat, cron/at/every, `schedule_wake`, CC-session-end and task-due triggers are all
   new **callers of `wake()`**. None of them may enqueue a headless run any other way.
4. Before raising `HEADLESS_SLOTS`, make the cap a real lock rather than a per-process count.
5. `agent_inbox` `mode='followup'` (collect/debounce) is reserved and not yet written.
