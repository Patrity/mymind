# Agent Worker + Workstreams Implementation Plan (cycle 81, harness step 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All agent runs execute in a separate `apps/worker` process connected to the web over a Postgres event/command bus, and Bridget can start long-running, resumable, budgeted workstreams that survive tab closes and web redeploys.

**Architecture:** `@mymind/core` gains a bus (`run_events` + `worker_commands` + `NOTIFY`), a cross-process hub/live-bus/approval/abort/undo layer, and a workstream state machine. `apps/worker` is an esbuild-bundled Node entry that owns execution; the Nuxt web process subscribes, renders, does STT/TTS, and sends commands.

**Tech Stack:** pnpm workspace, `@mymind/core`, Postgres (`pg` LISTEN/NOTIFY), drizzle, esbuild, Nuxt 4/Nitro, AI SDK v6, vitest, playwright-cli, systemd.

**Spec:** `docs/superpowers/specs/2026-10-11-worker-and-workstreams-design.md`

## Global Constraints

- Web never claims or executes a run once Task 3 lands; the worker is the only executor.
- Frames on the bus are today's hub frames minus audio; UI behaviour of chat must be unchanged except where the spec moves it (TTS source).
- Text/reasoning deltas coalesced ≈50ms per run before insert; `NOTIFY` payloads ≤ 8KB (pointers or `{resource,action,id}` only).
- Commands needing an answer (undo, abort-for-clear) time out at 10s with a user-visible error — never a silent success.
- Workstream approvals wait without timeout; chat approvals keep 120s auto-deny. Cycle-79 taint/approval-nonce rules unchanged.
- `initCore` for the worker comes from env through ONE mapper shared with the web's runtime-config names (no drift: `NUXT_DATABASE_URL` etc.).
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build` (+ worker bundle build). Lint not a gate.
- Conventional commits, **no attribution trailers**. Mutation checks: commit first, mutate, restore with `git checkout -- <file>`, `git diff --quiet`. Never `git stash`. Dev DB shared — tests touch only their rows. Kill only your own processes (PID + path verified).

## Review Focus

1. **Lost frames / double frames** — notify missed, web restart mid-run, two sockets on one conversation, replay overlap. Task 1/3 tests.
2. **Approval deadlock** — worker waits on a decision nobody can send (no web socket, workstream vs chat timeouts, iMessage path). Task 4 tests.
3. **`/clear` ordering** — epoch written before the aborted run's rescue persists. Task 4 test.
4. **Workstream runaway** — budget not enforced across segments/restarts, re-enqueue loop on repeated failure. Task 5 tests.
5. **Deploy topology** — worker unit not restarted, worker and web on different code versions mid-deploy, migrations order. Task 2/7.

---

### Task 1: Bus in core (events, commands, live-change)

**Files:** migration (drizzle: `run_events`, `worker_commands`, `worker_heartbeat`), `packages/core/src/db/schema/bus.ts`, `packages/core/src/lib/bus/{events,commands,listen,live}.ts` + tests.

**Produces:**
```ts
// events.ts
export function createRunEventWriter(runId, conversationId, opts?: { coalesceMs?: number }): {
  emit(frame: HubFrame, only?: string | null): void   // buffers deltas, flushes ≤ coalesceMs
  flush(): Promise<void>; close(): Promise<void> }
export async function readRunEvents(q: { conversationId?: string; runId?: string; afterId?: number; limit?: number }): Promise<RunEventRow[]>
// listen.ts — one dedicated pg client per process, auto-reconnect, multiplexed channels
export function onNotify(channel: 'run_event' | 'worker_command' | 'live_change', fn: (payload: string) => void): () => void
// commands.ts
export async function sendCommand<T>(type, payload, opts?: { awaitResult?: boolean; timeoutMs?: number }): Promise<T | undefined>
export function handleCommands(handlers: Record<CommandType, (payload) => Promise<unknown>>): () => void   // worker side: notify + poll
// live.ts — cross-process publishChange/publishActivity (origin-deduped)
export function startLiveBridge(role: 'web' | 'worker'): () => void
```
- [ ] Failing DB tests: append+NOTIFY reaches a listener in a second pg client; coalescing merges 20 deltas within 50ms into ≤2 rows with identical concatenated text; `readRunEvents` replays after an id; `sendCommand(awaitResult)` round-trips with a handler in a child process (spawned via tsx) and times out at `timeoutMs` with a typed error; a command inserted while no listener exists is handled by the poll; live bridge delivers a worker-side `publishChange` to a web-side listener exactly once (origin dedupe).
- [ ] Implement; gates; commit `feat(bus): postgres run-event log, worker commands, cross-process live updates`.

### Task 2: `apps/worker` process + execution handover

**Files:** `apps/worker/{package.json,src/main.ts,src/env.ts,build.mjs}`, `pnpm-workspace.yaml` (`apps/*`), root scripts (`dev` runs both — e.g. `concurrently`/`npm-run-all` style or Nuxt `devServer` hook; choose the least-dependency option and justify), `server/plugins/agent-runtime.ts` (stop starting the worker loop; keep anything web-only), `nuxt.config.ts` scheduledTasks (agent tasks removed), `deploy/provision-native.sh` (+ `mymind-worker.service`), `.github/workflows/deploy.yml` (build worker bundle; restart worker after web), worker heartbeat writer, `CoreConfig` env mapper shared with `server/utils/core-config.ts` (move the key mapping into core so both use it), move `import.meta.dev` email flag into `CoreConfig` and the 9 direct `process.env` readers to config where the worker needs them.
- [ ] Failing tests: env mapper produces the same `CoreConfig` as `fromRuntimeConfig` for the same values (table test incl. `NUXT_` names); worker boot runs `recoverOrphans`, starts tick + scheduled agent tasks + recorder flush (injectable deps); SIGTERM drain stops claiming and resolves after in-flight settle (fake runs); `kick` command triggers an immediate pump.
- [ ] esbuild bundle builds (`pnpm --filter worker build`) — native deps external (`pg`, `sharp`, etc.), `yaml` declared now.
- [ ] Gates + local run: `pnpm dev` starts both; a chat turn still works (it now runs in the worker but streams via the in-memory hub only if Task 3 isn't done — so until Task 3 lands, keep execution in the web behind `AGENT_EXECUTOR=web|worker` env, default `web`; Task 3 flips the default and removes the flag).
- [ ] Commit `feat(worker): apps/worker process, env mapper, drain, provisioning`.

### Task 3: Streaming over the bus + TTS in web

**Files:** core hub implementation backed by `createRunEventWriter` (the runner's `hub.publish` path), `server/api/voice/ws.ts` (subscribe via `onNotify('run_event')` + `readRunEvents` replay by seq; `only_sink`), web-side TTS for origin sinks (move segmenter/`speakWithPreset` usage from orchestrator into a web module driven by streamed deltas), remove audio from the runner, Breeze queue web-only, flip `AGENT_EXECUTOR` default to `worker` and delete the flag.
- [ ] Failing tests: a run executed by a worker child process streams the same frame sequence a socket received before (golden test from an in-process run of a fake model); late join replays from seq; web restart (new subscriber) resumes without duplicates; `only_sink` frames reach only that socket; TTS: web module speaks a sentence once its deltas complete, only for the origin sink with `speak`.
- [ ] Browser check: chat turn with tool call renders identically; voice turn speaks.
- [ ] Commit `feat(worker): stream runs over the bus; TTS in the web process`.

### Task 4: Commands — approvals, abort/clear, undo, presence, caches

**Files:** worker-side approval channel (publish `approval` event, await `approval-decision`), `ws.ts` approval forwarding, `abort` + `/clear` ack, `undo.post.ts` → `sendCommand('undo')`, `/api/presence` → `presence`, every settings PUT that invalidates a cache → `invalidate`, worker handlers.
- [ ] Failing tests (worker child process): exec approval approved from the web side resumes the run; denied → denied result; chat approval auto-denies at 120s (fake timers); `/clear` writes the epoch only after the worker's abort ack, and a rescued message from the aborted run never lands after the epoch; undo of a task created by a worker run succeeds via command and reports `expired` after the TTL; presence makes `isAway` false in the worker; an `invalidate` makes the worker re-read ai-registry config.
- [ ] Commit `feat(worker): approvals, abort/clear, undo, presence and cache invalidation across processes`.

### Task 5: Workstreams backend

**Files:** schema (`workstreams`, `agent_runs.kind`), `packages/core/src/lib/agent/workstreams/{store,loop,prompt}.ts`, tools `start_workstream` (core toolset), `finish_workstream` + `ask_tony` (workstream-only), gate classes, notifications via existing channels, resume-on-boot, budget accounting from run usage.
- [ ] Failing tests: start → segments advance until `finish_workstream` (fake model), summary posted to origin conversation; budget steps/wall exhausted → `failed` + final summary step, no further segments; `ask_tony` → `attention` + notification; reply → resumes; approval inside a workstream waits with no timeout and shows `attention {kind:'approval'}`; cancel stops after the current step; worker killed mid-segment → boot re-enqueues and continues from persisted thread; repeated segment failure (3 consecutive) → `failed` (no loop); `start_workstream` absent from workstream runs' tools.
- [ ] Commit `feat(workstreams): long-running budgeted workstreams with attention and resume`.

### Task 6: Workstreams UI

**Files:** `app/pages/workstreams/index.vue`, `app/pages/workstreams/[id].vue`, components (reuse chat message/tool/approval components and hardened markdown), live resource `workstream` (skill `add-live-resource`), API `GET /api/workstreams`, `GET /api/workstreams/:id`, `POST /api/workstreams` (UI start), `POST /api/workstreams/:id/{cancel,resume}`, nav item, chat card for a started workstream, worker-offline banner (heartbeat).
- [ ] Browser-validate in this task (skill `browser-testing`): start from UI and from chat; live log updates; approval card in the workstream view; cancel; resume; offline banner when the worker is stopped.
- [ ] Commit `feat(workstreams): list, live detail view, controls`.

### Task 7 (controller): end-to-end, docs, deploy

- [ ] E2E: workstream research task survives a web dev-server restart and a worker kill; chat/voice/Stop/undo/approval regressions.
- [ ] Final review → fix wave → re-review; wiki (`agent-runtime.md`, new `workstreams.md`, `core-package.md`), handover, roadmap, mirrors.
- [ ] Confirm with Tony, then merge + deploy (new unit) + prod acceptance incl. restarting `mymind` during a workstream.
