---
title: Agent Runtime (server-owned turns, main thread, wake)
status: built
cycle: 73 (jobs callers, silent runs, light context and the queued frame: cycle 74; `reply_to`, iMessage approvals and channel deliveries: cycle 75)
updated: 2026-09-30
---

# Agent Runtime

Since cycle 73 a Bridget turn runs **on the server**, not inside a browser WebSocket.
`server/lib/agent/runtime/` is the only way a turn runs. A turn is an `agent_runs` row that a
worker claims and executes. Sockets are **viewers**: closing the tab unsubscribes and never
aborts. A reply keeps streaming, finishes and persists with nobody watching.

Spec: [`2026-09-27-bridget-runtime-design.md`](../superpowers/specs/2026-09-27-bridget-runtime-design.md) ·
Handover: [`2026-09-27-bridget-runtime.md`](../handovers/2026-09-27-bridget-runtime.md) ·
Related: [agent.md](agent.md) (the `/agent` surface), [voice-agent.md](voice-agent.md) (STT/TTS),
[agent-context.md](agent-context.md) (context assembly and tiers),
[agent-jobs.md](agent-jobs.md) (the scheduled and event callers of `wake()`, cycle 74).

The code is the source of truth. Where the spec and the code disagree, this page describes the
code. The build's deviations from the spec are listed in the handover.

## Modules

| File | Responsibility |
|---|---|
| `runner.ts` | `runTurn(run)`: runs one turn. This is the old `ws.ts` turn body moved verbatim: capture the leaf, load history (bounded), `assembleContext`, `handleTurn`/`runAgent`, persist, then send the `conversation`/`persisted` frames, with rescue on throw or abort. It persists drained steers as user rows, streams only `state` frames for a wake run, slices history to the last 4 turns for `context: 'light'`, and makes a suppressed wake leave no rows at all. |
| `queue.ts` | `enqueue` (resolve the session, then either steer or `createRun`), the pump (`pumpOnce` / `kick`), `execute` (10 s liveness bump, 5 min headless wall clock, `finishRun`, requeue of unread steers), `abortActive` / `abortActiveAndWait`, and `workerTick` (every 5 s: `recoverStale`, then `sweepCrashedFires()` (reliability pass: repairs `at` claims and event fire rows a crash left behind; see agent-jobs.md), then `jobsTick()` and `dueTaskEvents()` (cycle 74), then `startDeliveries()` (the outbox, started without awaiting it, single-flight; reliability pass) and `catchUpTick()` (cycle 75), each guarded on its own, then pump). `enqueue` carries an optional `replyTo` onto the new run, and `noSteer: true` (set by channel input) makes it always create a run, never steer. `workerTick` reaches `catchUpTick` through a dynamic `import()` (inbound.ts imports `enqueue` from queue.ts, so a static import back would be a cycle). After every run `execute` calls the jobs `onRunFinished` hook. |
| `runs.ts` | Run store: `createRun`, `claimNextRun` (one statement, `for update skip locked`, headless slot cap), fenced `touchRun`/`finishRun`, `activeRunFor`, `recoverOrphans`, `listRuns`. |
| `sessions.ts` | `resolveSession`. `main` returns the main conversation (created lazily; at most one, enforced by an index). `thread:new` makes a new side thread. `thread:<uuid>` returns an existing thread (the id's shape is validated before querying). `isolated:<slug>` makes a fresh thread titled `wake: <slug>`. |
| `stream.ts` | `StreamHub`: per-conversation fan-out to sinks, a replay buffer of the running turn's JSON frames, and `only:` targeting for audio. `withCid` tags frames with `cid`. |
| `inbox.ts` | `pushSteer` (atomic: inserts only if the run is still `running`), `drainSteerFor`, `requeueUnconsumed`. |
| `steer.ts` | `spliceSteers`: re-splices steers into every later step's messages. The AI SDK rebuilds each step from the initial messages. |
| `wake.ts` | `wake({ reason, prompt, sessionKey?, model?, jobId?, context? })`, the single headless entry point. |
| `gate.ts` | Headless tool policy (`classifyForHeadless`, `headlessTools`, `proposeAction`). |
| `replay.ts` | Approve or reject of an `agent-action` review row: claim, replay the stored call, settle, then append an event row. |
| `approvals.ts` | Interactive approval channels keyed by **run**. The exec allowlist check lives here too. |
| `aborts.ts` | runId → `AbortController`. It remembers an abort that arrives before the run registers (`preAborted`). |
| `recover.ts` | `recoverOnBoot` / `recoverStale` mark stale `running` rows as `interrupted`, append a `runtime:restart` event, requeue unread steers, and report a job run to the jobs hook as `failed` ("interrupted by a restart"), so it counts toward the job's 3-strike disable. |
| `summarize.ts`, `summarize-hook.ts` | Incremental thread summary writer, run after a run persists and by the `*/10` idle sweep. |
| `history.ts` | `groupTurns`, `turnTier`, `keepTrailingTurns`, `capToTokens`, and the constants `RUNTIME_CONTEXT_BUDGET = 20000`, `RECENT_THREADS_MAX_TOKENS = 600`, `MAIN_STATE_MAX_TOKENS = 300`. |
| `event-text.ts` | How an `event` row reads to the model: a plain sentence with no brackets. |
| `suppress.ts` | `isSuppressedReply`: `NO_REPLY` alone, or opening/closing a remainder of ≤ 300 chars. |

Wiring: `server/plugins/agent-runtime.ts` runs `recoverOnBoot()`, installs/revalidates jobs, then
`startWorker()`. Boot recovery failing does not stop the worker, because the periodic tick retries.

## Data model (migration 0054, additive)

- `conversations.kind`: `'thread' | 'main'`. The partial unique index `conversations_one_main`
  allows at most one main.
- `conversations.summarized_through`: the summary covers rows with `created_at` ≤ this.
  It is written from the last folded row's Postgres `created_at`, never the app clock.
- `conversation_messages.role` gains `'event'`. The new `origin` column holds values like
  `wake:<reason>`, `review:approved`, `review:failed` or `runtime:restart`.
- `agent_runs` columns: `id`, `conversation_id`, `session_key`, `trigger` (`user|wake`),
  `wake_reason`, `profile` (`interactive|headless`), `model_def_id`, `status`, `suppressed`,
  `input` jsonb, `origin_sink_id` (the socket that asked, used for TTS and audio targeting),
  `claimed_at`, `alive_at`, `owner` (migration **0055**: the boot id of the process that
  claimed it), `job_id` (migration **0056**: the job that fired it, `on delete set null`), `finished_at`, `error`, `usage`, `user_message_id`, `assistant_message_id`,
  `created_at`. Indexes: `(conversation_id, status)`,
  `(status, created_at)`, and the partial unique index **`agent_runs_one_running`** on
  `(conversation_id) where status='running'`. The index is the guarantee that one conversation
  never has two concurrent runs.
- `agent_runs.reply_to` (migration **0057**, cycle 75): jsonb `{ channel: 'imessage', chatGuid,
  messageGuid }`, set only when an inbound iMessage creates the run (inbound never steers — final
  review C1 — so it is never set on a running run). `input.origin` (`imessage:<chatGuid>`) is
  stamped on the persisted user row. See [Channels](#channels-cycle-75).
- `agent_inbox`: `run_id` (fk, cascade), `conversation_id`, `mode` (only `steer` is written this
  cycle), `content`, `attachments`, `source`, `created_at`, `consumed_at`. This deviates from the
  spec: steers are keyed to the run they target, and drain marks them with `consumed_at` rather
  than a `consumed_by_run` column.
- `review_queue_one_pending_per_target` is recreated with `and kind <> 'agent-action'`, so one
  run can propose several actions.

## Run lifecycle

```
queued ──claim──▶ running ──▶ done | failed | aborted        (execute → finishRun)
                     └──────▶ interrupted                     (recoverOrphans, alive_at stale > 60 s)
```

| Transition | Written by |
|---|---|
| → `queued` | `createRun`. Callers: `enqueue` (a user message, or `wake`), `requeueUnconsumed` (unread steers, always `trigger='user'`, `profile='interactive'`). |
| `queued` → `running` | `claimNextRun`. It picks the oldest queued run whose conversation has nothing running, and a headless run only while fewer than `HEADLESS_SLOTS = 1` headless runs are running. It sets `claimed_at`/`alive_at` = `now()` and `owner` = this process's `BOOT_ID` (a random UUID per process). A concurrent loser gets a unique violation, which is returned as null. |
| `running` (liveness) | `touchRun` every 10 s, **fenced** on `status='running'`. If the fence fails, another process recovered the run, so this process aborts it (`checkStillRunning`). |
| `running` → `done`/`failed`/`aborted` | `finishRun`, also **fenced** on `status='running'`. A run that was recovered while it was secretly alive keeps `interrupted`. `suppressed=true` is set for a silent wake (`NO_REPLY` or an empty reply). An abort by the headless wall clock is flagged `timedOut` on the outcome, so the jobs hook can tell it from Tony's Stop. |
| `running` → `interrupted` | `recoverOrphans`, when `coalesce(alive_at, claimed_at)` is older than 60 s. It runs at boot **and on every 5 s worker tick**, excluding run ids this process is executing. **At boot with `AGENT_RUNTIME_EXCLUSIVE=1`** (set in prod's systemd unit) it also takes every `running` row whose non-null `owner` is another boot id, however fresh — a deploy restart no longer leaves the thread "busy" for up to 60 s. Without the env (the shared dev DB) boot recovery stays age-only. It appends an event row ("A turn was interrupted by a restart…") and requeues unread steers. **No automatic retry.** |

After every terminal outcome, `execute` calls `requeueUnconsumed`. A steer that arrived too late
to be drained becomes the next run, whatever the outcome was. The spec said "abort only"; that
was overridden because it contradicted the spec's own "never silently dropped" rule.

**Steering.** When Tony sends a **plain-text** message while an **interactive** run is `running`
on that thread, `pushSteer` inserts it only if the run is still running (the check locks the run
row `for share`, so a concurrent `finishRun` waits and the requeue after it sees the steer). A
message with **attachments or a `/skill`** is never steered: a steer is text-only, so it queues
as its own run with its input intact. `runAgent`'s `prepareStep` drains it at
the next step boundary; an in-flight tool call finishes first. The runner persists drained steers
as their own user rows **in the same append** as the turn: `[question, steer…, reply]`, with the
reply last as the leaf. `groupTurns` joins consecutive user rows into one turn so a summary fold
can never split that append. Messages sent while a **headless** run is active are queued, not
steered. **Channel input never steers** (`enqueue({ noSteer: true })`, cycle 75 final review C1):
an inbound iMessage always becomes its own queued run carrying `reply_to` and `origin`, even
while an interactive run is active. A steer the run never reads is requeued as a bare run with no
`reply_to`, so a steered text could lose its phone reply, and a steer into an app turn would text
that turn's reply to the phone. App steering is unchanged. **Queued visibility (cycle 74):** when `enqueue` makes a user message its own run behind
one already running on the thread (a wake, or a non-plain message behind an interactive run), it
returns `queuedBehind: true`. `ws.ts` then answers `{type:'queued',text,cid}`, and the client
paints the user bubble at once. The bubble is replaced when that run's `user-message` frame
arrives.

## WebSocket protocol (`server/api/voice/ws.ts`, runtime path)

`ws.ts` is now a thin subscriber. It handles auth in `upgrade`, STT, the preset and model picks,
the approval UI and frame routing (`server/lib/voice/ws-routing.ts`). The authoritative frame
list is the comment at the top of `ws.ts`. The essentials:

| Client → server | Behaviour |
|---|---|
| `{type:'text',text,speak?,skill?,attachments?,conversationId?}` | `enqueue`. `conversationId` (a UUID) is the thread the client is showing and **wins over the socket's own view** — a socket that lost its state can never send the words into a new invisible thread. If an interactive run is active on the thread and the message is plain text, it is **steered** and the server replies `{type:'steered',text,cid}`. If it is queued behind a running run instead, the reply is `{type:'queued',text,cid}`. The enqueue step is serialised per socket (`submitLock`), so two quick messages on a new thread land in one thread. Voice uses the socket's current view. |
| binary WAV | STT happens **in the socket, before the run**, then it runs as an ordinary voice run (`speak=true`, `modality='voice'`). A steered utterance is followed by `state:'idle'`. |
| `{type:'load',conversationId}` | Selects the thread. It does **not** subscribe and does **not** abort. |
| `{type:'attach'}` | Subscribes to the selected thread **and** replays its running turn so far, in one synchronous step. The client sends it after committing the persisted transcript. |
| `{type:'new'}` | Stops viewing; the next text starts a new side thread. It does **not** abort. |
| `{type:'interrupt'}` | Stop, the **only** abort. It aborts the viewed thread's running run, this socket's last queued run on it, and a run whose enqueue is still in flight (`stopSeq`). It also denies that thread's pending approvals only. |
| `{type:'clear'}` | Denies the thread's approvals, then `abortActiveAndWait` (up to 10 s) so the aborted run's rescue rows land **before** the epoch, then writes the epoch. |
| socket close | Unsubscribes, drops this socket's approval channels and denies its pending approvals. Runs keep going. |

Server → client frames are the cycle-64 set (`chunk`, `user-message`, `audio-begin/end`, binary
PCM, `state`, `approval*`, `conversation`, `persisted`, `cleared`, `error`) plus `steered` and `queued` (both conversation-scoped). Every
JSON frame published through the hub carries **`cid`** (the conversation id), spliced in by
`withCid`. Audio and its bracket frames go only to the originating sink
(`only: run.originSinkId`). TTS runs only while that sink is still attached, so a closed tab
degrades to "no audio" and never to "no turn".

`turnId` comes from a process-wide counter seeded from `Date.now()`, so it stays monotonic across
restarts.

**Client side** (`app/composables/useVoice.ts`, `app/lib/voice/messages.ts`,
`app/lib/agent/turn-stream.ts`):
- `mapServerMessage` drops a conversation-scoped frame whose `cid` is not the viewed thread.
  While nothing is viewed (after `new`), `createLeftThreads()` drops frames for the thread ids
  the socket just left, and drops every tagged frame until the first submit after `new`.
- Turn tracking is split into two sets. `finished` is permanent and capped, for turns that
  genuinely ended. `discarded` is revocable and cleared on a thread switch, so going A→B→A can
  replay A's still-running turn.
- `attach(conversationId)` is idempotent per conversation. The page calls it after `resume()`
  commits the transcript.
- **Reconnect:** every socket open (`framesOnOpen`, `app/lib/voice/reconnect.ts`) re-sends the
  preset and model and, when a thread is on screen, `load` + `attach` for it, so a reconnected
  socket (deploy restart, sleep, a backgrounded phone tab) views and streams the same thread.

**Approvals (interactive).** `approvalFor(runId)` first checks the persisted exec allowlist, so
an allowlisted command runs even after the tab has closed. Otherwise it asks the originating
socket's channel. If that channel is gone, the call is **denied immediately**; it does not wait
out the 120 s timeout. Headless runs get no approval channel at all, and `exec` is excluded from
them.

**Approvals over iMessage (cycle 75).** An interactive run with no socket approval channel (an
inbound iMessage run, or an app run whose tab closed) registers
`replyToApprovalChannel(runId, { signal: ac.signal })` at turn start. At request time it reads the
run's `reply_to`. When that names an iMessage chat, it texts "Run \`cmd\`? 👍 to approve · 👎 to
deny" (worded per tool since cycle 76 — `decide_review` reads "Approve review decision: …?"; the
command cut to 300 chars) and waits up to **10 min** for a 👍/❤️ (approve) or 👎 (deny)
tapback on that message. Otherwise it denies, as before. **The wait honours the run's abort
signal** (final review I1): Stop or `/clear` settles the row `denied` and unwinds the run at once,
instead of leaving it `running` (blocking main) until the expiry. A socket channel registered by `ws.ts` overwrites it, so an app tab that is
watching still gets the in-app prompt. Details: [channels.md](channels.md#exec-approvals-over-imessage).

## Channels (cycle 75)

The runtime is how iMessage reaches Bridget and how her replies leave the app
([channels.md](channels.md)):

- **Inbound:** `handleInbound` enqueues an iMessage on **main** with `trigger: 'user'`,
  `profile: 'interactive'`, `input.origin`, `replyTo` and `noSteer: true`. It **never steers**:
  whatever is running on main (interactive or headless), the text queues behind it as its own run
  with its own `reply_to`, so every text gets its own answer on his phone.
- **Deliveries in the persist transaction:** the runner's `appendMessages` gets an `inTx` hook. In
  a savepoint on the same transaction it calls `planDeliveries(run, reply, tx)` (`reply_to`, the
  job's `deliver` list, presence) and inserts the `channel_deliveries` rows. The reply
  and its deliveries commit together. A planning read failure rolls back to the savepoint and the
  reply saves without deliveries. An empty or suppressed reply plans nothing, and the **rescue
  path never delivers** the partial reply. After commit it publishes `channelDelivery` `created`.
- **Failure note:** a turn that ends `failed` (not `aborted`) on a run with `reply_to` queues one
  `source: 'note'` iMessage, "Sorry — something went wrong answering that." (`queueFailureNote`,
  in the runner's `finally`), so the phone is not left silent.
- **Presence in the chat:** `channelPresence.start(run)` marks the reply chat read and turns
  typing on at turn start; `stop` turns typing off in the `finally`. Both are fire-and-forget.
- **Worker tick:** after `jobsTick` and `dueTaskEvents`, `workerTick` starts `deliveriesTick()` (the
  outbox) off the tick via `startDeliveries()` (it does not wait on sends; one batch at a time) and `catchUpTick()` (self-throttled to 2 min), each guarded on its own.

## Headless runs, `wake()` and the gate

`wake({ reason, prompt, sessionKey = 'main', model?, jobId?, context? })`:
- `reason` must be a slug: `^[a-z0-9][a-z0-9:_-]{0,79}$` (80 chars, so `job:<64-char slug>` fits).
- `jobId` is stamped on `agent_runs.job_id`. `context: 'light'` goes into `input.context` and
  limits history to the last `LIGHT_CONTEXT_TURNS = 4` turns. The summary and recent-threads
  tiers still apply.
- It enqueues `trigger='wake'`, `profile='headless'`.
- The runner persists the prompt as an **`event` row** (`origin = wake:<reason>`) in place of a
  user row.
- The system prompt gets a **BACKGROUND WAKE** section ("Tony is not watching… reply with
  exactly NO_REPLY") and drops the confirm-before-editing rule.
- In model history an event row reads `Background wake (<reason>): <prompt>`, a plain sentence
  with no brackets, because the model imitates whatever its history looks like.
- **Wake runs stream only `state` frames** (cycle 74): no user-message, text, reasoning, tool
  or usage chunks. A subscriber sees the reply only through the `persisted` re-read, so a
  suppressed reply is never glimpsed, and no live assistant message is left open for a run that
  turns out silent.
- **Silent runs leave nothing (cycle 74, D4):** if the final reply is `NO_REPLY` (or opens or
  closes with it and ≤ 300 chars remain) **or is empty/whitespace**, the run persists **no rows
  at all**: no event row and no assistant row. It sends no `conversation`/`persisted` frame and
  skips `afterPersist`. The run is `done` with `suppressed=true`, and its `agent_runs` row is the
  only trace (the Runs drawer shows "silent"). A rescued wake with no reply rescues nothing
  either. Cycle 73 kept the event row; that is gone.
- Limits: 16 steps, a 5 min wall clock (then abort), and one headless run in flight globally.

Callers today:
- **Jobs** (cycle 74, [agent-jobs.md](agent-jobs.md)): the scheduler tick, `cc.session_end` and
  `task.due` events, **Run now** and the `run_job` / `schedule_wake` tools. Every job fire uses
  reason `job:<slug>`, so its divider origin is `wake:job:<slug>`.
- `POST /api/admin/agent/wake` with body `{ reason, prompt, sessionKey?, model? }`. It
  **requires a web session** (`requireSession`), because a bearer API token must not be able to
  start an unattended run. Wake validation errors and unknown threads return 400; anything else
  returns 500.
- The `/wake <prompt>` composer command posts to that endpoint with `reason: 'manual'`.

**Headless gate** (`gate.ts`, applied in `runner.ts` `headlessProfile`):

| Class | Tools | Headless behaviour |
|---|---|---|
| exclude | anything `dangerous` (`exec`) | not offered |
| run | every `kind: 'read'`, plus `APPEND_TOOLS` = `save_memory`, `create_task`, `create_project`, `quick_capture`, `generate_image`, `save_document`, `create_job`, `edit_job`, `run_job`, `schedule_wake`, `send_message` (cycle 75: Tony-only, rate-limited), plus `FREE_TOOLS` = `delete_job` (destructive-kind, but job upkeep is hers, spec D2; checked before the destructive rule) | runs |
| propose | every `kind: 'destructive'`, plus `PROPOSE_TOOLS` = `edit_document`, `edit_section`, `update_document`, `move_document`, `sync_document`, `edit_image`, `create_skill`, `edit_skill` | handler not run; inserts `review_queue` `kind='agent-action'`, `target_kind='agent_run'`, `proposed={tool,args,conversationId}`; returns `{proposed:true, reviewId, note}` and the run continues |

An unclassified tool **throws** in `classifyForHeadless`, and a test enumerates the whole
registry. `makeSubagentTool` throws on any non-`read` tool, because subagents call `agentTools`
directly and would otherwise bypass the gate.

**Approve** (`POST /api/review/[id]/approve`, handler `agent-action` in `server/api/review/kinds.ts`):
1. `claim` moves the row from `pending` to `applying` with a compare-and-set, so a double
   approve replays nothing twice.
2. `replayAgentAction` re-validates the args against the tool's **current** zod schema; schema
   drift makes the approval fail. It then runs the handler inside `withSpan`, registers undo and
   publishes activity.
3. `settle` moves the row from `applying` to `approved` or `failed`.
4. An event row is appended to the originating thread: `review:approved` with "Approved: <tool>
   — <summary>", or `review:failed`.

The approve toast offers undo using the returned `undoToken`.

**Reject** marks the row `rejected` and appends nothing.

## Summaries and the two context tiers

- `getAgentHistory` reads the active path with `sinceEpoch` + `sinceSummary`, so the model sees
  only the tail after `summarized_through`. `getConversation` (the UI) still returns everything.
- The runner groups history into turns and passes `costTurns(turns)` plus
  `budget: RUNTIME_CONTEXT_BUDGET` (20000) to `assembleContext`. It keeps only the trailing
  `turns.length - droppedTurns` turns. **The cycle-70 turn tier is live.** `costTurns` prices
  each turn **after** `applyHistoryPolicy` (read results capped, out-of-window payloads elided)
  — the form `buildModelMessages` actually sends — and `fitBudget` **always keeps the newest
  turn**, even past the ceiling, so one tool-heavy turn can never leave the model with no history.
- `maybeSummarize(conversationId, { force? })` does nothing if the thread has ≤ 6 turns. It also
  does nothing (unless `force` is set) while the unsummarised tail (post-policy cost) is
  ≤ 12 000 tokens. Otherwise it folds the **oldest** turns outside the last 6 — whole turns, at
  most `SUMMARY_FOLD_MAX_TOKENS` (24 000) of transcript per call — into `summary`
  (`chat('bulk')`, incremental from the previous summary), advances `summarized_through` to the
  end of that chunk and re-embeds `summary_embedding`; the next fold continues from there.
  Transcript lines are `Tony:` / `Bridget:`; event rows appear as their own `Note (…):` /
  `Background wake (…):` sentence, never as Tony. Returns `skipped | summarized | failed`.
- **The write is epoch-guarded:** the fold reads `context_epoch_at` (as text, microsecond-exact)
  with the summary at start and updates only `where context_epoch_at is not distinct from` that
  value. A `/clear` landing during the multi-second summarizer call makes the fold write nothing.
- Triggers: after every persisted or rescued run (`maybeSummarizeLater`, fire-and-forget), and
  the `summarize-threads` Nitro task (`*/10`). That task
  force-folds side threads idle ≥ 30 min, touched in the last 7 days, with `message_count > 12`
  **and** more than 12 rows after `summarized_through` (so caught-up threads are not re-picked),
  **most recently active first**, 20 at a time. It records `{ summarized, failed }` via
  `recordJobSummary('summarize-threads', …)`.
- **`recent-threads`** (main only): side-thread summaries with `last_message_at` in the last
  48 h, newest first, prefixed by title, capped at 600 tokens.
- **`main-state`** (side threads only): the first paragraph of main's summary, capped at 300
  tokens.

Both tiers are fixed tiers in `assembleContext`, capped at the source.

## UI

- `/agent` opens the main thread by default (`GET /api/agent/main`, created lazily). The thread
  rail pins it at the top as "Bridget".
- `event` rows render as a divider: `woken · <reason>: …`, `review · approved: …`, `runtime: …`.
- The **Runs drawer** (main thread only, `app/components/agent/RunsDrawer.vue`) reads
  `GET /api/agent/runs?conversationId=&limit=`, newest first, limit clamped to 1–200. A malformed
  `conversationId` returns 400. Each row shows `durationMs` from claim to finish. The drawer is
  live-invalidated by the `agentRun` resource.
- `/review` renders `agent-action` cards (`app/components/review/AgentActionCard.vue`) with the
  tool, pretty args, a link to the originating thread, and Approve / Reject.

## Rollback

Cycle 74 deleted the cycle-73 rollback lever (`server/lib/voice/ws-legacy.ts`, the
`agent_runtime` settings flag, and every branch that read it) — `server/lib/agent/runtime/` is
now the only way a turn runs, unconditionally. Roll back by redeploying a cycle-73 build (revert
the cycle-74 merge); the `agent_runtime` setting no longer exists.

**A code revert alone leaves the reverted build with no skills.** On its first boot, cycle 74
moved every skill document into `agent_skills` and soft-deleted the document; cycle-73 code reads
skills only from `documents`. After redeploying the cycle-73 build, un-delete exactly the moved
documents. Each move soft-deleted its document (`deleted_at = now()`, the transaction start) and
recorded a `system` skill revision (`clock_timestamp()`, milliseconds later) in the **same
transaction**, and the move is the only writer of `system` skill revisions. Match on both:

```sql
-- 1. preview: the documents the cycle-74 move soft-deleted (expect one row per system revision)
select d.path, d.deleted_at from documents d
where d.type = 'skill' and d.deleted_at is not null
  and d.path like '/projects/mymind/skills/%'
  and exists (
    select 1 from agent_config_revisions r
    where r.target_kind = 'skill' and r.actor = 'system'
      and r.created_at >= d.deleted_at and r.created_at < d.deleted_at + interval '5 seconds'
      and r.content like '---' || chr(10) || 'name: '
          || regexp_replace(d.path, '^.*/([^/]+)\.md$', '\1') || chr(10) || '%');
select count(*) from agent_config_revisions where target_kind = 'skill' and actor = 'system';

-- 2. un-delete them (same predicate), in a transaction; check the row count against step 1
begin;
update documents d set deleted_at = null
where d.type = 'skill' and d.deleted_at is not null
  and d.path like '/projects/mymind/skills/%'
  and exists (
    select 1 from agent_config_revisions r
    where r.target_kind = 'skill' and r.actor = 'system'
      and r.created_at >= d.deleted_at and r.created_at < d.deleted_at + interval '5 seconds'
      and r.content like '---' || chr(10) || 'name: '
          || regexp_replace(d.path, '^.*/([^/]+)\.md$', '\1') || chr(10) || '%');
commit;

-- 3. skills created or edited AFTER the move exist only in agent_skills — recreate these by
--    hand as documents (or accept losing the edits); the un-deleted documents hold the pre-move text
select s.slug, r.actor, r.created_at from agent_skills s
join agent_config_revisions r on r.target_kind = 'skill' and r.target_id = s.id and r.actor <> 'system'
order by r.created_at;
```

The window and the `name:` match keep older soft-deleted skill documents (deleted before cycle
74, or by hand) deleted. Verified read-only on the dev DB on 2026-09-28: the preview matched
exactly the 6 moved documents (6 `system` revisions) and none of the 12 other soft-deleted skill documents in that folder.
The four job tables stay (migration 0056 is additive) and are simply unused by cycle-73 code.

## Operational queries

```sql
-- shape of the run table
select status, count(*) from agent_runs group by 1;

-- stuck runs: running but not bumped for > 60 s (the worker tick should already have
-- recovered these; a non-empty result means no worker is running)
select id, conversation_id, profile, claimed_at, alive_at from agent_runs
where status = 'running' and coalesce(alive_at, claimed_at) < now() - interval '60 seconds';

-- queued work that is not moving
select id, conversation_id, profile, trigger, created_at from agent_runs
where status = 'queued' order by created_at;

-- recent wakes and whether they spoke
select created_at, wake_reason, status, suppressed, error from agent_runs
where trigger = 'wake' order by created_at desc limit 20;

-- agent-action proposals, including ones stuck mid-apply
select id, status, proposed->>'tool' tool, created_at from review_queue
where kind = 'agent-action' order by created_at desc;
```

## Known limits

- **No retry of interrupted runs.** A half-run tool loop is not safely repeatable. Tony sees the
  `runtime:restart` event row.
- **One headless slot**, enforced per process by a count subquery with no lock.
- **The UMAP layout still blocks briefly.** `computeLayoutAsync` yields between epochs; the
  worst stall went from 9434 ms to 4582 ms, and the remainder is umap-js's synchronous kNN init.
- **The restart wedge is handled only in exclusive mode.** With `AGENT_RUNTIME_EXCLUSIVE=1`
  (prod) boot recovery takes over the previous boot's runs at once. Without it (the shared dev
  DB) a run killed mid-turn by a restart still looks alive for up to 60 s: messages are
  "steered" into it and nothing answers until the periodic tick recovers it and requeues them.
- **A queued bubble can linger.** If the queued run ends `interrupted` (recovered after a
  restart), no `user-message` or `persisted` frame replaces the optimistic bubble, so it stays
  until a reload. A message queued with attachments shows its text only until its run starts.
- **Steers land only at step boundaries.** An in-flight tool call or a long single generation
  finishes before a steer is read; a steer that arrives during the last step becomes the next run.
- **A cycle-73 rollback build is not risk-free once `event` rows (`role='event'`) exist** —
  pre-cycle-73 code does not know that role. See Rollback above.
- **An `agent-action` row stuck in `applying`** after a crash between claim and settle is
  invisible in `/review`. It is not auto-reset, because the tool may already have run.
- `agent-action` cards have no "rationale"; proposals carry no rationale field.
- **Steer persistence:** steer rows sit before the whole reply, which is coarser than where they
  were spliced live. They carry no `origin`.
