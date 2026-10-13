---
title: Workstreams (long-running background agent work)
status: shipped
cycle: 81 (workspace integration: cycle 82; coordinator + child workstreams: cycle 83; sticky taint: cycle 84)
updated: 2026-10-12
mymind_id: a5fa582b-9998-41b3-a9b3-53a41c8a0642
mymind_hash: e1e54a62356e287a0759b440dfe50c29f0b27d542f8923e653ed5f735d2784a5
---

# Workstreams

A **workstream** is Bridget's long-running, budgeted background work on one goal. It runs in
**segments** on its own thread (titled `⚙ <goal>`), executed by the agent worker like any other run.
It can pause to ask Tony a question or to get an approval, and it ends with a summary posted to the
chat it was started from.

Spec: [`2026-10-11-worker-and-workstreams-design.md`](../superpowers/specs/2026-10-11-worker-and-workstreams-design.md) §5,
[`2026-10-12-coordinator-design.md`](../superpowers/specs/2026-10-12-coordinator-design.md) (+ its amendments, cycle 83) ·
Related: [agent-runtime.md](agent-runtime.md) (runs, the worker, the bus), [channels.md](channels.md) (iMessage),
[workspace.md](workspace.md) (cycle 82: the sandboxed workspace every workstream gets),
[ai-providers.md](ai-providers.md#subagents-model-class-and-per-model-pools-cycle-83) (the `subagents` model
class and per-model pools behind the Coordinator section below) ·
Handover: [`2026-10-12-coordinator.md`](../handovers/2026-10-12-coordinator.md).

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

| State | Meaning | iMessage answer routing | Nudged |
|---|---|---|---|
| `queued` | created; first segment not claimed yet | — | — |
| `running` | a segment is executing, or the next one is queued | — | — |
| `running` + `stateDetail: 'evaluating'` (cycle 84) | the judge is still deciding a Smart-Approvals-eligible call — no new state, just a detail on `running` | no | no |
| `attention` + `{kind:'question'}` | `ask_tony` | **yes** (tagged `#k` when several are open — see [Coordinator](#coordinator-cycle-83)) | yes, ≤ 3 |
| `attention` + `{kind:'approval'}` | a tool call waits on Tony's approval card | no | yes, ≤ 3 |
| `paused` + `{kind:'paused', text}` | Tony pressed **Stop** in its thread, **two idle segments** in a row, or (cycle 83) a coordinator waiting on its children/a watch | **no** | **no** |
| `done` | `finish_workstream` | — | — |
| `failed` | budget used up (after a final summary step), or 3 consecutive failed segments | — | — |
| `cancelled` | Cancel | — | — |

There is no cap on how many workstreams may be in a non-terminal state — see
[The removed top-level cap](#the-removed-top-level-cap) under Coordinator.

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

**The judge (cycle 84).** Every such card also gets a rule-tier floor + an LLM verdict
(`⚖ <risk>/<recommendation> — <first reason>`, or `⚖ pending` while it is still being judged), shown
on the card, in the attention banner, and (mirrored) in the away iMessage prompt. **While an eligible
call is being judged**, the workstream shows `running` + `stateDetail: 'evaluating'` (above) instead
of waiting in `attention` — attention is only set once a human is actually needed, and the time spent
evaluating doesn't count against the segment's wall budget. With **Smart Approvals for workstreams**
on (Settings → Bridget → Judge; **off by default**), a verdict of `approve` at high enough confidence
can resolve the card on its own — `decided_by: 'judge'`, a "⚖ auto-approved (0.94): reason" thread
note, **unless the workstream itself is tainted** (next section) or the rule floor is `high`/
`critical`/`deny` (host `exec` always is). More than one card waiting at once keeps the newest as the
primary attention and names every other one in `alsoParked`; a drain parks all of them the same way.
Full reference: [judge.md](judge.md).

## Telling Tony

- `notifyTony`: an event row in the origin chat with the link, plus a text when he is **away**.
- **Nudges**: a workstream in `attention` is re-announced at most every **2 h**
  (`NUDGE_EVERY_MS`) and at most **3 times per attention episode** (`MAX_NUDGES`; a new question or
  card starts a new episode). It is never re-announced while `paused`.
- **iMessage answers** (`routeInboundAnswer`; cycle 83 final fix wave I2). Every question text carries a
  `#k` tag (`attention.tag`, `tagQuestion`), issued monotonically and **never reused within 7 days** (table `workstream_question_tags`, migration 0080). An inbound iMessage while
  a workstream waits on a **question** becomes an answer: `#k …` answers the question tagged k (the tag
  is stripped); an untagged text answers the **most recently notified** question. Its next segment's
  prompt keeps origin `imessage:<chat>`; main gets a short "answered ⚙ …" note, and when several were
  waiting Tony is texted which one got it and the others' tags. A `#k` naming a recently issued question
  that has **closed** gets "↪ #k (<goal>) is already closed — your reply was not passed on to any
  workstream." and is never rerouted (even with one question open). Any other unknown `#k`, or no
  question at all, lands in main as an ordinary turn; Bridget can pass it on
  with `answer_workstream`. Paused and approval-waiting workstreams never capture a text. A child's
  question is routable only once escalated to Tony.
- **Coordinator trees (cycle 83 final fix wave M4).** Away texts about a coordinator's children
  (approval cards, escalated questions) are ONE text per tree listing everything waiting, at most every
  10 min (`workstreams.tree_away_at`); a throttled moment's items go out on the tick
  (`sweepTreeAway`). A lone child approval keeps its interactive iMessage prompt. Nudges for children
  are one per tree.

## Coordinator (cycle 83)

Spec: [`2026-10-12-coordinator-design.md`](../superpowers/specs/2026-10-12-coordinator-design.md)
(+ its amendments) · Handover: [`2026-10-12-coordinator.md`](../handovers/2026-10-12-coordinator.md).
Model class + pools: [ai-providers.md](ai-providers.md#subagents-model-class-and-per-model-pools-cycle-83).

Any workstream becomes a **coordinator** by loading the on-demand `coordinator` toolset
(`start_workstream({toolsets:['coordinator']})`, or `load_toolsets` mid-run) — there is no separate
kind (D1). A coordinator splits its goal into **child workstreams** that run in parallel, in their
own threads, and merges their results. Depth is 1 (D2): a child's registry has no `coordinator`
toolset, so children cannot spawn children.

### Toolset and tools

On demand, **top-level workstream segments only** (`workstreamProfile`; a child's
`childWorkstreamProfile` never has it; chat's `bridgetProfile` never has it either — chat starts a
coordinator with `start_workstream({toolsets:['coordinator']})` rather than fanning out itself).
Every handler re-checks the caller is a top-level, non-child segment.

| Tool | Limits |
|---|---|
| `spawn_workstreams({children})` | ≤ 50 per call (`MAX_SPAWN_PER_CALL`); each child's optional `model` must be one of the configured `subagents` labels; a child cannot be given the `coordinator` toolset; reserved against the tree budget **all-or-nothing** (below). Its description lists the current `subagents` labels + descriptions and the current `treeLeft`, rebuilt per segment. |
| `wait_for_workstreams({ids, until, timeoutMin})` | ≤ 200 ids; `until` `'all'` (default) or `'any'`; `timeoutMin` 1–1440, default 60. Returns at once if already satisfied; otherwise parks the coordinator — see Wait/park/wake below. |
| `read_workstream({id, tail?, offset?})` | `tail` 0–20 log lines, default 5; returns the child's **full** summary, paged past `READ_SUMMARY_PAGE` (8000 chars) via `offset`/`nextOffset`. |
| `steer_workstream({id, message})` | message ≤ 4000 chars; refused for an ended child or one Tony stopped himself (`paused` + `lastOutcome:'aborted'`). |
| `answer_child({id, answer})` | answer ≤ 4000 chars; only for a child with a pending **question** (refused if Tony already answered it directly in the child's own thread). |
| `cancel_workstreams({ids \| 'all'})` | ≤ 200 ids, or `'all'`; only touches the coordinator's own live children. |
| `export_to_coordinator({paths})` | child-side (`workspace` toolset, `own`-workspace children only). ~700 KB compressed (the 1 MB tool-result output cap); uncompressed capped at `min(200 MB, coordinator workspace's quota − bytes used)` (`EXPORT_MAX_UNPACKED_BYTES`); at most `EXPORT_MAX_ENTRIES` = 20,000 archive members; refuses links/devices/sparse members; listed with `tar --numeric-owner` (a crafted owner name can't spoof the size check). |

`spawn_workstreams`, `steer_workstream` and `answer_child` are `outbound` (approval-gated once the
coordinator's run is tainted). The toolset's headless class is `"run"` (`gate.ts APPEND_TOOLS`),
alongside `export_to_coordinator` — both act only on the workstream's own tree, budget-bounded,
never from a chat/job run.

`finish_workstream` is refused while any non-terminal child remains — **except** (final fix wave
M3) when every remaining one already has `cancelRequested`: they finish in the background and the
refusal message no longer suggests cancelling again.

### Child lifecycle

A child gets its own thread (`⚙ <goal>`), `origin_conversation_id` = the coordinator's thread,
`parent_id` = the coordinator, and `is_child = true` — set at spawn and **never cleared**. Every
child rule (depth, toolsets, routing to the coordinator vs Tony, tree accounting, nudges,
`export_to_coordinator`, resume) keys on `is_child`, not `parent_id`, because `parent_id` goes
`NULL` the moment the coordinator's row is deleted. A child whose coordinator is gone or has ended
is **cancelled**, never promoted to top-level work (the transition hook, backed by the worker
tick's orphan sweep). Deleting a coordinator's thread cancels its live children first
(`cancelChildrenOfThread`, under the tree lock, so a spawn still committing is caught too); the
sweep catches anything a crash missed within 5 s.

A coordinator reaching a terminal state (cancel, budget exhaustion, failure) cancels every child
still going. A child's failure never fails the coordinator — the coordinator decides, woken with
the failure reason.

### Tree budget

*Amended by the final fix wave (I1) — the numbers below supersede the original spec text.* The
tree budget counts **children's steps only**, summed; the coordinator's own budget is **not**
inside the tree, and **wall time is not a tree dimension** (each child is bounded by its own
`maxWallMs`, default 1 h; the coordinator by its own budget; parked time burns neither).

- `start_workstream({toolsets:['coordinator'], treeBudget:{maxSteps}})` sets it at start — default
  `DEFAULT_TREE_BUDGET` = **2000** steps, bounds **1–10,000** (`TREE_BUDGET_LIMITS`). A workstream
  that loads `coordinator` **later** (mid-run) gets the default at its first spawn.
- **Committed** is computed from the rows every time, never a counter: a live child reserves
  `max(its budget, its used)`; an ended child counts only what it actually used (the rest
  refunds). `reservationOf`/`committedOf`/`treeRemaining`
  (`packages/core/src/shared/types/workstreams.ts`) are the **one** formula shared by the core's
  spawn/resume checks and the UI's tree meter (Task 3 fix round 1) — they cannot drift apart.
- Spawn is all-or-nothing, under one advisory lock per tree (`mymind:workstream-tree:<id>`) plus
  the coordinator row `FOR UPDATE`: two racing spawn calls can never both take the tree's last steps.
- With all defaults, **ten** 200-step children fit in the 2000-step tree at once.
- Resuming an ended child is refused once its coordinator has ended, or if the extension it needs
  doesn't fit what's left of the tree.
- A child's own default budget is 200 steps / 1 h (`DEFAULT_CHILD_BUDGET`), clamped to the usual
  `BUDGET_LIMITS` (1–2000 steps, 1 min–24 h).

### Model labels

See [ai-providers.md § `subagents`](ai-providers.md#subagents-model-class-and-per-model-pools-cycle-83)
for the full model class, `description`/`maxInFlight`, resolution order and the ramp. In short:
`spawn_workstreams({children:[{model:'<label>'}]})` picks a child's model by one of the configured
`subagents` labels (first = default, omitted = default). The DTO's `resolvedModel` names what a
child actually resolves to right now (its label's model, else the first `subagents` entry, else
`reasoning`'s head) — the Children panel shows that instead of "default model" once it resolves
(final fix wave C2).

### Wait / park / wake

`wait_for_workstreams` works like `watch`: it returns at once if already satisfied; otherwise it
arms `seg.wait` and ends the turn (`seg.stop = 'wait'`). When the segment ends, the loop parks the
coordinator as `paused {waitingForChildren}` — **no segment runs, no wall clock burns** — then
immediately re-checks (a child that ended before the wait was armed wakes it at once). Every child
transition re-checks too, and the worker tick (`sweepCoordinators`, every 5 s) sweeps parked
coordinators for deadlines and anything a restart missed.

A wait is satisfied when: every (`until:'all'`) or any (`until:'any'`) listed child has ended;
**any** of the coordinator's children — listed on this wait or not — has a question or pause it
hasn't been shown yet; a listed id no longer exists; or the deadline passes. The wake is one
guarded transition under the tree lock (`paused+waiting → running`), so of any number of
concurrent wakers exactly one enqueues the `segment:children` segment; a cancelled coordinator is
never woken. A coordinator parked on a **watch** (not a child wait) is woken the same way by a
child's question (ruling C6a) — its watch stays armed and is delivered at the next segment boundary.

The wake report is **never dropped**: if a segment is already queued (Tony's reply, Resume) the
report's event row is appended to the thread now, under the claim lock, before that segment's turn
reads it; if a segment is **running**, the report is spliced into it as a steer, persisted as its
own event row (never mixed with Tony's words); otherwise it is its own `segment:children` segment.
A child's question/pause counts as shown (`reported`) only once the report is durably in the
thread — a failed or aborted segment un-shows it, so it's never silently lost (parked (b) + M7).

### `ask_tony` routing and escalation

A child's `ask_tony` wakes its coordinator, not Tony (spec D8). The coordinator answers
(`answer_child`) or asks Tony itself. If the coordinator is **itself held by Tony** (`attention`,
or `paused` for anything but its own children-wait or a watch), the child's question is also
**escalated**: Tony is notified once, titled `<coordinator goal> › <child goal>`, and the
question's `attention.escalated = true`. Approvals in a child always go straight to Tony with the
same title, regardless of the coordinator's state.

The `#k`-tagged iMessage reply mechanism and the per-tree away-text grouping are covered under
[Telling Tony](#telling-tony) above (final fix wave I2 and M4) — this is the piece that's new to
coordinators specifically: a child's question is only routable by iMessage once it has been
escalated to Tony, and the escalation note names the coordinator as well as the child.

### Taint

Spec D9: child output is untrusted. `workstreams.tainted` (migration 0077, never cleared)
persists that a run of the workstream read mail/calendar/contacts — needed because the mail
result itself can leave a child's own history window before the coordinator gets around to
reading its summary. `childTainted(c)` is `c.tainted` OR its workspace is tainted (its own, or —
for a `shared` child — the coordinator's); an unreadable workspace row fails closed (tainted).
Every `read_workstream`/`wait_for_workstreams` result carries `CHILD_UNTRUSTED_NOTE`; when a shown
child is tainted, `workspaceTainted: true` is the **first** key of the result — that taints the
reading run (`ai-tools.ts`) and seeds the next run's taint through history (survives
`capResult`). A wake report **withholds** a tainted child's own words entirely (state only — "read
it with read_workstream").

**Sticky for the workstream's whole life (cycle 84 final fix wave, C1/I1).** A run's taint used to be
seeded only from its model-visible history, so a mail read 3 tool-bearing turns back (elided by the
history policy) no longer tainted a later segment — its outbound tools ran un-gated (a cycle-81 hole)
and Smart Approvals could auto-run its `gmail_send`. Now:
- `workstreams.taint_sources text[]` (migration 0083; `mail` | `flagged` | `workspace`, a union that
  only grows) records WHY. A row `tainted` with no sources (written before 0083) reads as `mail`.
- `beginSegment` seeds every segment's run (`RunAgentCtx.taint.initial`) with the stored sources plus
  `workspace` when its workspace is tainted (unreadable → tainted) — across segment boundaries,
  yield/resume, restarts and coordinator wakes alike.
- A new source is persisted **the moment** the run gains it (`ai-tools.ts` `onTaint` →
  `seg.markTainted(sources)` → `addWorkstreamTaint`, a SQL union), not at segment end.
- Work a tainted run starts inherits its taint at row creation: `start_workstream`'s workstream and
  every `spawn_workstreams` child (run taint ∪ the coordinator row's stored taint).
- Chat conversations are unchanged (taint still decays with the history window; chat Smart Approvals
  is off by default). Full reference, including the rule tier, verdicts and the output guard that
  feeds `flagged`/`workspace` sources: [judge.md](judge.md).

### Workspace modes

`workspace_mode` (`'own'` default, or `'shared'`) on each child. An `'own'` child gets its own
sandbox; a `'shared'` child runs inside the **coordinator's** workspace (its `workstreamId` stays
its own, so its own watches still wake it). `export_to_coordinator({paths})` (child-side, `own`
children only) packs files into the coordinator's `/workspace/from/<childId>/`.

**Children do not preload the `workspace` toolset** (final fix wave I4 — a deliberate narrowing of
cycle 82's blanket pre-load for every workstream segment). A child gets `workspace` only when its
spawn spec lists `"workspace"` in `toolsets` (it then starts in the child's own toolset list) or it
loads it itself mid-run. This matters because sandbox containers are a scarce, shared resource
(`SANDBOX_MAX_RUNNING`) — a wide fan-out of research children that never touch files never starts
a container. Coordinators keep the unchanged pre-load behaviour.

### Lifecycle notes and report rows

Two different things land in a coordinator's thread, rendered differently:
- **Lifecycle notes** (ruling S1): one event row per child state change (spawned, asking a
  question, waiting for approval, paused, done, failed, cancelled), origin `workstream:<childId>`.
  **State-only** — the child's own goal text (the coordinator's own words) and what happened,
  **never its output** — so a note can never carry taint. Written once per event
  (`lifecycle_noted`, compare-and-set), and **never while a run is active in the coordinator's
  thread** (a row appended mid-turn would land on a branch nobody reads) — flushed at segment end,
  at a wake, on child transitions with no wake, and by the tick sweep. The UI (`LifecycleRow.vue`)
  renders these as one compact line: an icon, "Child", a goal link, and the state.
- **Report rows** — the wake report (`segment:children`) and any report steered into a running
  segment — carry the children's actual summaries/questions/failure text. They're `kind:'report'`
  in the UI (`ReportCard.vue`): collapsed by default, an "untrusted — written by child runs" badge,
  and the body renders as **escaped plain text only** (a `<pre>` interpolation — no markdown,
  links, images or previewers), because it's text other agent runs wrote.

Child text in a report is capped (final fix wave I3): each child's own summary/question/failure
text at `CHILD_TEXT_CAP` = 1500 chars per field (with "(truncated — read_workstream for the full
text)"), and the whole report at `CHILD_REPORT_CAP` = 24,000 chars — past that, the **oldest**
children collapse to one line each (a flagged question stays visible even collapsed).
`read_workstream` is the escape hatch: it returns the full summary, paged past
`READ_SUMMARY_PAGE` = 8000 chars. A **replayed** `wait`/`read` tool result on a later segment is
still capped at the general [`READ_RESULT_CAP` = 1500](agent.md#tool-history-cycle-43) — that
scenario (I3 "scenario B") isn't covered by this fix wave; see the handover's backlog.

### Away-iMessage grouping per tree

See the "Coordinator trees" bullet under [Telling Tony](#telling-tony) above (final fix wave M4):
one away iMessage per coordinator tree per 10 minutes, listing everything its children wait on
Tony for, instead of one per child; a lone child approval keeps its own interactive prompt; nudges
are one per tree too.

### The Children UI and list API semantics

- **Children panel** (workstream detail, a coordinator only — `treeBudget` set, or `childCount` /
  `childIds` non-empty): a tree budget meter ("Children's steps: `<used> used · <reserved>
  reserved / <tree>`" — no wall-time meter, since wall isn't a tree dimension), then one row per
  child (state badge, goal link, model badge via `childModelLabel` — the resolved model, else the
  label, else "default model" — steps/time used vs reserved, Steer and Cancel through the child's
  own control routes). The detail page's tab reads "Children (`childCount`)".
- **`/workstreams`** nests children under their coordinator (`UTable` `get-sub-rows`, collapsed by
  default): a coordinator row reads "coordinator · N children"; an expanded child row reads
  "child · `<model>`", indented, with its "Started from" linking "its coordinator".
- **`GET /api/workstreams?state=&limit=`** — `limit`/`state` apply to **top-level** rows only
  (`parent_id IS NULL`). Each listed coordinator embeds at most `CHILDREN_IN_LIST` = 20 of its
  children (still-going first, then newest — one window-function query, `listChildrenEmbedded`),
  with `childCount` = the true total and `childIds` = **only the embedded ones** in this response.
  The response is bounded at ≤ 100 × 21 rows regardless of fan-out. An orphaned child (its
  coordinator deleted, `parent_id` NULL but still `is_child`) is listed as its own top-level row.
- **`GET /api/workstreams/:id/children`** (new) — the full, paged list: `?limit` 1–200 (default
  200, `CHILDREN_PAGE_MAX`), `?offset` ≥ 0, oldest first; `[]` for a plain workstream; 404 for a
  bad id. The UI's "+N more" (shown when `childCount` exceeds what's embedded) loads from here and
  replaces the embedded set.

### The removed top-level cap

Spec D3: the 3-workstream top-level cap (`MAX_ACTIVE_WORKSTREAMS`) is **gone** — deleted along
with `WorkstreamCapError`, the start/resume cap checks, and the HTTP 409 `cap` code. No headcount
cap remains at any level (the only sanity limit left is ≤ 50 children per `spawn_workstreams`
call). Governance is now **budget + model-capacity**, not headcount: a coordinator's own tree
budget bounds its fan-out (above), and per-model in-flight pools (see
[ai-providers.md](ai-providers.md#subagents-model-class-and-per-model-pools-cycle-83)) bound how
many segments of ANY kind — coordinators and ordinary workstreams alike — run against one model at
once. Jobs still can't start a workstream unattended: `start_workstream`'s headless class stays
`PROPOSE` (`gate.ts`).

## Tools

| Tool | Who | Notes |
|---|---|---|
| `start_workstream({goal, toolsets?, budget?, treeBudget?})` | Bridget (core toolset) | Not available inside a workstream. In a headless run it becomes a `/review` proposal. `treeBudget` only applies with `toolsets:['coordinator']` — see [Coordinator § Tree budget](#tree-budget). No cap (cycle 83: see [The removed top-level cap](#the-removed-top-level-cap)). Profile-only: **not on MCP**. |
| `finish_workstream({summary})` | workstream segments only | → `done`. Refused while a non-terminal child remains, unless every remaining one is already `cancelRequested` (cycle 83 M3). |
| `ask_tony({question})` | workstream segments only | → `attention {question}`. In a child, this reaches its coordinator first (cycle 83 D8) — see [Coordinator § `ask_tony` routing](#ask_tony-routing-and-escalation). |
| `answer_workstream({id, text})` | Bridget | Answers a **question** or resumes a **paused** workstream. Refused for running work or an approval card, and inside a workstream. `outbound` (gated after a Google read; a proposal when headless). |

The `coordinator` toolset (`spawn_workstreams`, `wait_for_workstreams`, `read_workstream`,
`steer_workstream`, `answer_child`, `cancel_workstreams`) and `export_to_coordinator` are covered
in full under [Coordinator § Toolset and tools](#toolset-and-tools) above.

## API and UI

| Route | Auth | Does |
|---|---|---|
| `GET /api/workstreams?state=&limit=` | session or token | list **top-level** workstreams, newest first (`limit` clamped to 100); each coordinator embeds up to 20 children (cycle 83 — see [Coordinator § list API semantics](#the-children-ui-and-list-api-semantics)) |
| `GET /api/workstreams/:id` | session or token | one DTO |
| `GET /api/workstreams/:id/children` | session or token | a coordinator's children, paged (cycle 83) |
| `POST /api/workstreams` | **session only** | start (from the UI; no origin chat) |
| `POST /api/workstreams/:id/resume` | **session only** | resume a failed, cancelled, paused or attention one |
| `POST /api/workstreams/:id/cancel` | session or token | cancel |
| `POST /api/workstreams/:id/steer` `{text}` | **session only** | steer while running; answer a question; continue a paused one |

Start, resume and steer require a web session (final review I5, and re-review NEW-1 for steer).
This follows the `wake.post.ts` rule: the auth middleware also accepts API tokens, and a leaked
token must not be able to launch an unattended background run. A steer can answer a question or
continue a paused workstream, so it can restart work too. Cancel stays token-capable, including a
child's (Task 3 concern 1: the brief's "session-only" reading was not applied to the reused
control routes — stopping work never widens it).

Controls go to the worker as a `workstream-control` command, awaited for 10 s. A worker that does
not answer gives a visible 504.

The UI:
- **`/workstreams`** (nav item) lists the workstreams: state badge, goal, elapsed, steps, cost and
  origin — **nested** (cycle 83): a coordinator's children collapse under it by default; see
  [Coordinator § Children UI](#the-children-ui-and-list-api-semantics).
- **`/workstreams/[id]`** shows one workstream:
  - the budget meter;
  - what it waits on (the question or approval text, or the **Paused** reason);
  - the summary;
  - Cancel and Resume;
  - a steer, answer or continue box;
  - its live step log from `run_events`, rendered with the same components as chat (hardened
    markdown, tool parts, approval cards, Undo) — plus (cycle 83) `ReportCard`/`LifecycleRow` for a
    coordinator's child events;
  - a **Children** tab (cycle 83) when it is a coordinator.
- **Chat** shows a compact card for a workstream started from it. Its mirrored approval cards show
  as orphan cards (see [agent-runtime.md](agent-runtime.md#processes-and-the-bus-cycle-81)).
- Live updates use the `workstream` resource, debounced ~700 ms for the list prefix (cycle 83 M1);
  the detail key stays immediate.

## Retention

A workstream segment's `run_events` (its step log) are kept **while the workstream exists**. Other
runs' events are pruned 7 days after they finish. There is no delete action for a workstream yet,
so finished workstreams keep their logs indefinitely (final review M4, open).
