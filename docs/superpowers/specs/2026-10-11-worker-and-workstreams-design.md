---
title: "Agent worker + workstreams — runs move to apps/worker over a Postgres event bus; long-running workstreams (cycle 81, harness step 2)"
cycle: 81
date: 2026-10-11
status: spec
supersedes: null
builds_on: 2026-10-09-core-package-extraction-design.md
---

# Agent worker + workstreams (cycle 81 — harness step 2)

Step 1 (cycle 80) put the worker-needed code in `@mymind/core`. This step moves **every run** out of
the Nitro web process into a separate worker, makes everything that crossed in-memory boundaries
cross a Postgres bus, and adds **workstreams**: long-running, resumable, budgeted agent work you can
walk away from. Done = a research workstream keeps going while you close the tab and while the web
app redeploys; chat, voice, approvals, Stop and undo still work.

## 1. Decisions (brainstorm 2026-10-10 → 10-11)

| # | Decision | Rejected |
|---|---|---|
| D1 | One cycle for worker plumbing + workstreams | 2a/2b split |
| D2 | **Postgres bus**: append-only `run_events` + `NOTIFY` pointer (worker→web); `worker_commands` + `NOTIFY` (web→worker) | Redis; direct internal socket |
| D3 | **TTS moves to the web process**: worker emits text; the web's WS handler synthesizes for the origin socket | PCM over the bus |
| D4 | **Undo routed to the worker** by command; tokens stay worker-memory closures (10-min TTL) | persisted inverse operations |
| D5 | Workstreams = a run kind with its own thread, segmented loop, budgets, `ask_tony` attention state, interactive (waiting) approvals | headless-gated workstreams |
| D6 | Web never executes a run; the worker owns the 5s tick, jobs, outbox, iMessage catch-up, agent scheduled tasks, observability flush | shared execution |

## 2. Processes

**`apps/worker`** — Node entry (`apps/worker/src/main.ts`) on `@mymind/core`, bundled with esbuild to
`apps/worker/dist/worker.mjs`; `initCore` from env (`NUXT_*`/plain names mapped in one place, same
values the web uses); its own systemd unit `mymind-worker` (provisioned by
`deploy/provision-native.sh`, restarted by CD after the web cutover). Owns: claiming + executing runs
(chat turns, wakes, jobs, workstreams), `workerTick` (recover, crash sweep, jobs, task events,
deliveries, iMessage catch-up), the agent scheduled tasks (`summarize-threads`, `reflect-threads`,
`reflect-jobs` and the post-turn summarize hook), `startRecorderFlushLoop`.
**Graceful drain:** SIGTERM → stop claiming, let in-flight steps finish (≤60s), checkpoint
workstreams, mark chat runs that can't finish `interrupted` (existing recovery semantics), exit.
Boot → `recoverOrphans` + resume workstreams.

**Web (Nuxt)** — UI, API, WS (STT in, TTS out), approvals UI, presence, settings. Never claims a run.
`server/plugins/agent-runtime.ts` stops starting the worker loop; Nitro `scheduledTasks` keep only
non-agent jobs.

**Dev:** `pnpm dev` runs Nuxt and the worker together (worker via `tsx watch apps/worker/src/main.ts`).

## 3. The bus

### 3.1 `run_events` (worker → web)
`id bigserial`, `run_id`, `conversation_id`, `seq int` (per run), `type text`, `payload jsonb`,
`only_sink text null` (origin-socket targeting), `created_at`. Index `(run_id, seq)`,
`(conversation_id, id)`. The worker's hub implementation appends events (text/reasoning deltas
coalesced ≈50ms per run) and `NOTIFY run_event, '<conversation_id>:<id>'`. Frames are exactly
today's hub frames (`user-message`, `chunk`, `state`, `conversation`, `persisted`, `error`,
approval frames) minus audio.
The web keeps one `LISTEN` connection; on notify it reads new rows for conversations with
subscribers and fans out to sockets (`only_sink` respected). Reconnect/late join replays from the
client's last seq (replaces the in-memory replay buffer). Retention: events of runs finished > 7 days
ago are pruned daily (workstream logs: see §5.4).

### 3.2 `worker_commands` (web → worker)
`id bigserial`, `type text`, `payload jsonb`, `created_at`, `handled_at null`, `result jsonb null`.
`NOTIFY worker_command, '<id>'`; the worker also polls unhandled rows each tick (missed notify safety).
Types: `kick`, `abort` (`runId` or `conversationId`; result = settled), `approval-decision`
(`requestId`, approved), `undo` (`token`; result = `UndoResult`), `presence` (lastActiveAt),
`invalidate` (`cache`: ai-registry | channels | observability | persona | skills | search | imagegen |
exec-secrets), `workstream-control` (cancel/resume/steer). Commands that need an answer
(`abort` for `/clear`, `undo`) wait on `result` via the event channel with a timeout (10s → error to
the user).

### 3.3 Live updates
`publishChange` and `publishActivity` go cross-process: the in-process emitter stays for local
listeners, and every publish also `NOTIFY live_change, <json>` (payload ≤ 8KB — events are
`{resource, action, id}`); the web's SSE route listens. Duplicate local+remote delivery in the web
process is deduped by an origin id.

### 3.4 Approvals across processes
The runner's approval channel in the worker publishes an `approval` event (full `ApprovalRequest`,
incl. `title`, `logSummary`, nonce-bound details) and waits for an `approval-decision` command.
The web renders the card (unchanged UI) and forwards the decision. iMessage approvals keep their DB
path. Chat runs keep the 120s timeout (auto-deny); **workstream approvals wait without timeout**
(attention state). Approval pins/taint stay inside the run (unchanged).

### 3.5 Abort, `/clear`, Stop
Stop/barge-in → `abort` command; the worker aborts the run's controller and replies when settled.
`/clear` waits for that reply before writing the epoch (preserves today's ordering guarantee).

### 3.6 Presence, caches, TTS queue
`/api/presence` writes the web's in-memory value **and** sends `presence`; the worker keeps the last
value. Settings PUT routes send `invalidate` after their local invalidation. The Breeze TTS queue
lives only in the web (the worker no longer synthesizes).

## 4. Voice (TTS in the web)
The runner stops calling TTS. The web's WS handler, for a turn whose `originSinkId` is its socket and
`speak` is on, runs the existing sentence segmenter + `speakWithPreset` over the streamed text deltas
and sends `audio-begin` / PCM / `audio-end` to that socket. Voice presets resolve web-side (as today
at turn start). STT unchanged.

## 5. Workstreams

### 5.1 Model
`agent_runs` gains `kind text not null default 'turn'` (`turn` | `workstream`). A `workstreams`
table holds the long-lived object: `id`, `conversation_id` (its own thread, kind `thread`, titled
`⚙ <goal>`), `origin_conversation_id`, `goal`, `state` (`queued|running|attention|done|failed|cancelled`),
`toolsets text[]`, `budget jsonb` (`{ maxSteps: 400, maxWallMs: 7_200_000 }` defaults),
`used jsonb` (`{ steps, wallMs, inputTokens, outputTokens, costUsd }`), `attention jsonb null`
(`{ kind: 'question'|'approval', text, requestId }`), `summary text null`, `current_run_id`,
`created_at`, `updated_at`, `finished_at`.

### 5.2 Loop
A workstream advances in **segments**: each segment is one `agent_runs` row (`kind='workstream'`,
profile `interactive`) running `runAgent` with `maxSteps: 40` over the workstream thread's history,
then persisting its messages. The worker re-enqueues the next segment until: the model calls
`finish_workstream(summary)`; budget exhausted (state `failed`, reason recorded, summary of progress
requested in a final no-tools step); cancel; or `attention`. System prompt adds the goal, budget used,
and the rules (work autonomously; use `ask_tony` only when blocked; call `finish_workstream` with a
summary when done).

### 5.3 Tools
- `start_workstream({ goal, toolsets?, budget? })` (Bridget, core toolset) → creates the workstream,
  returns its id + link; not available inside a workstream (no recursion this step).
- `finish_workstream({ summary })` (workstream runs only) → state `done`, summary posted as an event
  message to the origin conversation and a notification on the usual channel.
- `ask_tony({ question })` (workstream runs only) → state `attention`, notifies (iMessage when away,
  else app); the next segment starts when Tony replies in the workstream thread.
Headless gate classification: `start_workstream` → run; the other two → run.

### 5.4 Behaviour
- Approvals inside a workstream wait (attention `{kind:'approval'}`) — no auto-deny, no timeout; the
  card shows in the workstream view, chat and iMessage.
- Toolsets: declared ones pre-loaded; auto-load as usual. Taint rules unchanged.
- Restart/deploy: the segment in flight is interrupted; on boot the worker re-enqueues the workstream
  from its persisted thread (a `restarted` event in its log).
- Steer: a message typed into the workstream thread while running is a steer (existing inbox path);
  while in attention it answers the question.
- `run_events` of a workstream are kept while the workstream exists (its step log).

### 5.5 UI
`/workstreams` (nav item): list — state badge, goal, elapsed, steps, cost, origin. Detail
`/workstreams/[id]`: live step log rendered from `run_events` (text, tool chips, approvals — the same
components as chat, hardened markdown), budget meter, Cancel / Resume, steer/answer box, summary
when done. Live updates via the `workstream` live resource. Chat shows a compact card linking to a
workstream started from it.

## 6. Error handling
- Worker down: web shows "agent worker offline" (heartbeat row the worker updates every tick;
  stale > 30s) and queued runs wait; chat input still enqueues.
- Command with no worker answer within 10s (undo / abort-for-clear): user-visible error, no silent
  success.
- NOTIFY missed: web re-reads `run_events` by last seq on every notify and on a 2s poll while any
  run it streams is active; worker polls `worker_commands` each tick.

## 7. Testing
- Unit/DB: bus append + coalescing + NOTIFY delivery + replay from seq; command round trips (abort,
  undo, approval-decision, invalidate) between two processes in a DB test (spawn a worker child);
  live-change cross-process; workstream state machine (segments, finish, budget exhaustion, attention,
  cancel, resume after kill); `start_workstream` not callable inside a workstream.
- Existing suites stay green (counts reported; changes only where behaviour intentionally moved,
  e.g. TTS tests now web-side).
- Browser (playwright-cli): chat turn with tool call + Stop; an approval (exec) approved in the card;
  undo of a created task; voice turn speaks (TTS from web); start a workstream from chat → watch the
  live log → **restart the web dev server mid-run → the log resumes and the workstream finishes**;
  kill the worker mid-workstream → restart → it resumes.
- Prod acceptance after deploy: same flows on prod + `systemctl restart mymind` during a workstream.

## 8. Deploy
New systemd unit `mymind-worker` (provisioned idempotently), CD: build web + worker bundle, migrate,
restart web, restart worker (drain). Rollback = previous commit (both units).

## 9. Out of scope
Sandboxed workspace/file tools (step 3), coordinator + child workstreams (step 4), judge (step 5),
eval (step 6), Mac move (step 7); workstreams spawning workstreams.
