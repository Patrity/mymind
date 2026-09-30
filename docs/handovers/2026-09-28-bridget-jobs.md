---
title: Bridget jobs — markdown-configured schedules and triggers, plus Skills and Jobs as first-class pages
cycle: 74
date: 2026-09-28
status: built
branch: feat/bridget-jobs (worktree .claude/worktrees/bridget-jobs, base 211205c)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-09-28-bridget-jobs-design.md
plans:
  - ../superpowers/plans/2026-09-28-bridget-jobs.md
wiki:
  - ../wiki/agent-jobs.md
  - ../wiki/agent-runtime.md
  - ../wiki/agent-skills.md
migrations:
  - 0056 agent_skills, agent_jobs, agent_config_revisions, agent_job_fires; agent_runs.job_id (fk, on delete set null)
migrations_run_on_prod: false  # 0056 is applied to the shared dev DB only; the skills data move runs from a boot plugin, not the migration
seed_jobs_enabled: false  # morning-brief, evening-wrap, heartbeat, session-digest ship DISABLED; Tony enables them on /jobs
final_review: fixed  # 0 C / 5 I / 11 M; I1-I5 and M1-M8, M10, M11 fixed in the fix wave; M9 parked as a deviation
prod_agent_timezone: unset  # prod is Etc/UTC; set Settings -> Bridget -> Agent timezone to America/Chicago after deploy, BEFORE enabling any seed
mymind_task: null  # set by the controller
---

# Cycle 74: Bridget jobs

Cycle 73 gave Bridget a runtime and one headless entry point, `wake()`, but nothing called it.
Cycle 74 makes her talk on her own. Every proactive behaviour is a **job**: a markdown file with
YAML frontmatter (trigger, timezone, active hours, model, thread, context, deliver, enabled) and
a prompt body. She and Tony can both edit jobs, and every change is a revision you can revert.
Skills moved out of `documents` into their own table. Skills and Jobs are now main-nav pages built
on one shared markdown editor, extracted from `/documents`.

**Status:** built on `feat/bridget-jobs`. All gates are green and all six browser acceptance
scenarios pass. The final whole-branch review (0 critical, 5 important, 11 minor) is fixed; see
[Final review fix wave](#final-review-fix-wave). It is **not merged and not deployed**. Migration
0056 is on the shared dev DB only.

**The four seed jobs ship disabled.** `morning-brief`, `evening-wrap`, `heartbeat` and
`session-digest` are installed on boot with `enabled: false`. Tony turns them on from `/jobs`.
Nothing speaks on its own until he does.

How it works today: [`docs/wiki/agent-jobs.md`](../wiki/agent-jobs.md), plus the updated
[`agent-runtime.md`](../wiki/agent-runtime.md) and [`agent-skills.md`](../wiki/agent-skills.md).

## What shipped

- **Migration 0056:** `agent_skills`, `agent_jobs`, `agent_config_revisions` (last 100 per
  target), `agent_job_fires` (event dedupe), and `agent_runs.job_id`. It is additive, and the
  only migration this cycle.
- **`server/lib/agent/jobs/`:**
  - `parse`: the job file, validated;
  - `schedule`: croner, DST-safe, active-hours aware, with a bounded scan;
  - `store`: the only writer, with CAS, guards, revisions, boot revalidation and seeds;
  - `tick`: exactly-once claim, single catch-up, overlap skip, `at` self-disable, 30-day prune,
    Run now;
  - `events`: `cc.session_end` and `task.due`, deduped;
  - `outcome`: spoke/silent/failed, the failure streak, auto-disable after 3;
  - `wake-time`: `schedule_wake`'s `when` parser.
- **The tick is wired** into the cycle-73 `workerTick`, as `jobsTick()` then `dueTaskEvents()`,
  each guarded on its own. `onRunFinished` runs after every run in `execute`. The boot plugin
  installs the seeds and then revalidates every job.
- **`SessionEnd` hook** (`server/api/hooks/cc/[event].post.ts`) fires `cc.session_end` without
  waiting, keyed by the session id.
- **Seven agent tools:** `list_jobs`, `get_job`, `create_job`, `edit_job`, `delete_job`,
  `run_job` and `schedule_wake`. They run directly in background runs (D2; `delete_job` via
  `FREE_TOOLS`) and are exposed on MCP.
- **Skills storage swap.** `server/services/skills.ts` reads and writes `agent_skills`, with a
  markdown source, CAS and revisions. The boot plugin `server/plugins/agent-skills-migrate.ts`
  moves legacy skill documents idempotently. The prompt index, `use_skill`, the slash-command
  tier, MCP and the API all read the new table.
- **HTTP:**
  - `/api/jobs`: list, create, get (with the next 5 fire times and last 10 runs), CAS put,
    delete, enabled, run, revisions and revert;
  - `/api/skills/:name/source`: get and put;
  - `/api/skills/:name/revisions` and `/revert`.
- **Runtime changes (cycle-73 code):**
  - `wake()` takes `jobId` and `context`.
  - `context: light` keeps the last 4 turns.
  - **A silent wake persists no rows.**
  - A wake streams only `state` frames.
  - The `queued` frame gives an immediate bubble for a message queued behind a running run.
  - `steered` carries `cid`.
  - **The legacy WS path and the `agent_runtime` flag are deleted** (`ws-legacy.ts`, `flag.ts`,
    every branch that read them). The runtime is always on.
- **UI:**
  - `MarkdownConfigEditor` (extracted from the documents editor; `/documents` was refactored
    onto it);
  - `useConfigSource`;
  - `RevisionsPanel` (line diff, revert);
  - `JobStatusPanel`;
  - `/skills` and `/skills/[slug]`;
  - `/jobs` and `/jobs/[slug]` (with templates);
  - Skills and Jobs in the main nav, and the Settings "Agent Skills" tab removed;
  - live `agentSkill` / `agentJob` resources.

## Gates

| Gate | Baseline (211205c) | Build (7fdeea5 + docs) | After the final review fix wave (03e3d80) |
|---|---|---|---|
| `pnpm test` | 2318 pass · 1 skip | 258 files · 2485 pass · 1 skip | **261 files · 2497 pass · 1 skip** |
| `pnpm test:db` | 391 pass | 54 files · 467 pass | **54 files · 483 pass** |
| `pnpm typecheck` | clean | clean | **clean** |
| `pnpm build` | ok | ok | **ok** |

Every new test was mutation-checked by its task's implementer and reviewer. The SDD ledger is
`.superpowers/sdd/2026-09-28-bridget-jobs/progress.md`, with per-task reports and reviews
alongside it.

## Browser acceptance (playwright-cli, dev on :3074, 2026-09-28 05:36–05:52 CDT)

The assertions are on DOM text, API JSON and DB rows, never on the model's wording. The chat
model was LiteLLM `qwen3.8-flash-next`. Rig port 8004 was down, but it is not in the reasoning
chain head.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Heartbeat `every 5m` from `/jobs`; next fire times; Run now | **PASS** (both paths) | I used New job → Heartbeat template → slug `accept74-heartbeat`, set `trigger: every 5m`, `enabled: true`, and saved. The panel read "every 5 minutes · America/Chicago" with 5:43, 5:48, 5:53, 5:58 and 6:03 AM CDT, which matches `GET /api/jobs/:slug` `nextFireTimes` (10:43:05Z + 5 min steps) and the stored `next_run_at`. **Run now** created run `d06a0282` (`job_id` set, `input.context=light`) → `done`, not suppressed. Main got a `wake:job:accept74-heartbeat` event row and the reply. The job showed `last_outcome=spoke`, and `next_run_at` was unchanged (schedule untouched). Recent runs showed "spoke · just now · 4 s · view in thread". **Silent path:** with the body "Reply with exactly NO_REPLY", run `6bce9a41` was `done`, `suppressed=true`, with null user and assistant ids. The main thread's message count was **49 before and 49 after**. The Runs drawer listed "wake · job:accept74-heartbeat · done · silent" and the job read `last_outcome=silent`. Run now on a disabled job returned `{skipped:'disabled'}` (since changed by the final review's M10: a human Run now runs a disabled job). |
| 2 | Broken frontmatter → inline error; doesn't fire | **PASS** (as ruled: rejected at write) | I typed `trigger: sometimes soon` plus `bogus_key: 1` and pressed Save. The page showed "Not saved · unknown key: bogus_key" and the panel showed "Invalid · unknown key: bogus_key". The DB `content_hash`, `parse_error` (null) and `next_run_at` were **unchanged**, so the broken file was never stored and cannot fire. A direct `PUT` with `every 1m` returned **400** "trigger must fire at least 5 minutes apart". Navigating away raised the `beforeunload` guard. |
| 3 | "remind me in 10 minutes to stretch" → `at` job → fires → reply in main → disabled | **PASS** | From the `/agent` composer, `schedule_wake` created `reminder-25a098` (`source=agent`, `at 10:54:53Z`, enabled, `context: light`). `/jobs` showed the row "reminder-25a098 · agent · once on Sep 28, 05:54 · in 10 minutes". I moved its `at` to +70 s through a CAS `PUT`. The tick fired it at 10:46:22: run `done`, not suppressed, and main got the event row `wake:job:reminder-25a098` plus her reply. Afterwards the job had `enabled=false`, `fired_at` set, `next_run_at=null` and `last_outcome=spoke`. The revisions were agent (create) → human (move) → **system** (`enabled: false`). The `/jobs` switch rendered `aria-checked=false`. |
| 4 | `session-digest` enabled → a CC session ends → digest in main | **PASS** | I enabled it with the real switch on `/jobs`, minted a dev API token, and POSTed `SessionEnd` to `/api/hooks/cc/SessionEnd`. A bare synthetic session (no title or summary, 0 min) fired the job (an `agent_job_fires` row keyed by the session id, and the prompt carried the plain-sentence event block), and she judged it trivial: `silent`, which the job body permits. I then made a second synthetic session with a title, a summary and a 42-min duration (fixture set in the DB between SessionStart and SessionEnd): run `ead34925` was `done`, not suppressed, and the assistant row in main began "Session digest — "Cycle 74 acceptance…" (mymind, 42 min)". I disabled the job again with the switch. |
| 5 | `/skills/<slug>` edit, preview, revert; Settings entry gone; nav shows Skills + Jobs | **PASS** | New skill → `accept74-scratch`. I typed `## ACCEPT74EDIT heading` and a bold item, then Save. The source API had the text and the preview rendered an `<h2>` and a `<strong>`. The preview-only toggle hid CodeMirror, with cookie `mm.config.viewMode=preview`; edit mode showed it again (`=edit`). I selected revision 1 and clicked **Revert to this version**, which restored the original `contentHash` (`1fb83a…`) and left 3 revisions. With the editor dirty, Revert was disabled with the hint "Save or discard your edits first.". `/settings` has no skills link and no "Agent Skills" text. The nav has exactly one `/skills` and one `/jobs` link. |
| 6 | Message during a heartbeat run → bubble immediately ("queued"), answered after | **PASS** | I pressed Run now (wake run `6046b44d`, running 10:41:00.6–10:41:08.3) and then sent a message at 10:41:02.9. At 10:41:05, while the wake was still running, the transcript already showed the bubble (screenshot). The DB held the user run `queued`. The user run was claimed at 10:41:08.27, after the wake finished. The persisted order was event → wake reply → user → answer. After the reload the text appeared once, not twice. |

Screenshots (session scratchpad, not committed): `s0-jobs-list.png`, `s1-heartbeat-5m.png`,
`s1-run-now-spoke.png`, `s1-runs-drawer-silent.png`, `s2-invalid-rejected.png`,
`s3-reminder-on-jobs.png`, `s3-reminder-disabled.png`, `s3-reminder-in-main.png`,
`s4-digest-in-main.png`, `s5-skill-preview.png`, `s5-skill-reverted.png`,
`s5-settings-no-skills.png`, `s6-queued-bubble.png`, `s6-answered-after.png`.

**Cleanup.** I deleted `accept74-heartbeat`, `reminder-25a098` and `accept74-scratch`, with
their 13 revision rows. The fire rows went by cascade. I also deleted the two synthetic sessions,
their two `session-digest` fire rows and the dev API token, which brought the token count back
to 7. **All four seed jobs end disabled, with `content_hash` byte-identical to before**
(enable → disable through `setJobEnabled` round-trips exactly). `session-digest` gained two
revisions (enable, disable). The main thread keeps this run's rows as accepted (43 → 55
messages) and their 8 `agent_runs` rows.

**The heartbeat really used the gate.** Its first run proposed `forget_memory` on a test-noise
memory ("The user requested a list of numbers from 1 to 1000"). This is `review_queue`
`5774e687`, `agent-action`, still **pending**, left for Tony to decide.

## Final review fix wave

The final whole-branch review (`.superpowers/sdd/2026-09-28-bridget-jobs/final-review.md`) found
0 critical, 5 important and 11 minor issues. The rulings at the end of the SDD ledger decided each
one; the fix report is `final-fix-report.md` beside it. Every fix has a test that goes red when the
fix is removed (mutation-checked against the code, never by splicing a WHERE).

| # | Finding | Fix |
|---|---|---|
| I1 | Self-perpetuating wakes bypassed the 5-min and 50-enabled guards (`schedule_wake("in 1m")` chains; job A `run_job` B `run_job` A) | Agent-written `at` times need **≥ 5 min** lead; Bridget may create **≤ 10 `at` jobs per rolling hour** (counted from first revisions, so deletes don't reset it); `run_job` returns `refused_in_job_run` inside a job-fired run. `ToolContext` gained `runId` (runner → `handleTurn` → `runAgent` → `buildAiTools`). |
| I2 | `delete_job` left no revision and undo lost the history | `deleteJob` records a final revision (actor, run id) in the delete transaction; `restoreJob` re-creates under the **original id**; `delete_job`'s undo uses it. |
| I3 | Every `isolated` fire opened a new thread (empty for silent runs) | `isolated:<slug>` reuses the thread its newest run used — the stable key is `agent_runs.session_key`, recorded by every run and never pruned. A deleted thread is replaced on the next fire. |
| I4 | Event fires ignored no-self-overlap; `task.due` fired one wake per task | `fireEvent` skips a job with a queued/running run **without recording the key**; `task.due` fires each job **once per tick** with one event block listing every newly-due task, deduped per task, deferred (no keys) while the job's previous run is going. |
| I5 | No way to set the timezone; a later change never reached saved jobs; rollback left a cycle-73 build with no skills | **Settings → Bridget → Agent timezone** (IANA select, "Use browser timezone", "Server default"); `PUT /api/settings/agent-timezone` re-derives every job without its own `timezone:` (`rederiveDefaultTimezone`). The rollback un-delete SQL is in [agent-runtime.md § Rollback](../wiki/agent-runtime.md#rollback), verified read-only on dev. |
| M1 | The wake divider and the model's history dropped the job slug | `shared/utils/event-origin.ts` `splitOrigin` splits on the first colon, used by `Conversation.vue` and `event-text.ts`: "woken · job:<slug>". |
| M2 | "Summary: done.." | One full stop at most. |
| M3 | Agent revisions never carried `run_id` | They do now (`ToolContext.runId`); MCP calls have no run, so null. |
| M4 | `source` meant "last writer" and `system` became `human` | A `system` write keeps the existing `source`. |
| M5 | Disabling re-validated (a job pinned to a removed model could not be switched off, nor auto-disabled) | Disabling skips validation; only enabling validates. |
| M6 | An enabled `at` saved in the past sat enabled forever | Creating, saving or enabling an enabled past `at` is a validation error. |
| M7 | Skill documents the move skipped silently disappeared | Every remaining live `type='skill'` document is reported by path with a reason in the boot log. |
| M8 | The `/skills` toggle regenerated the markdown and dropped extra keys | An update that changes only `active` rewrites that one line (`setFrontmatterKey`). |
| M9 | Spec §11's per-job run counts on `/jobs` | **Parked** — a deviation (below); the wiki's run-count query covers it. |
| M10 | Run now on a disabled job was refused | A human Run now (API/UI) works on a disabled job; the agent's `run_job` still refuses. |
| M11 | `onRunFinished` ran after a fenced `finishRun` | Skipped when the finish was fenced (the row already says `interrupted`). |

**Browser-validated** (playwright-cli, dev on :3079, 2026-09-28 06:32–06:38 CDT), with a scratch
job `fixwave-tz` (`cron 30 7 1 1 *`, no `timezone:` line):
- **Agent timezone:** the field loaded as "Server default (America/Chicago)" (no setting on dev).
  I picked `Asia/Tokyo` with real clicks and saved. The toast read "5 jobs now follow
  Asia/Tokyo", the job's `timezone` became `Asia/Tokyo` with `next_run_at` 2026-12-31T22:30Z
  (from 2027-01-01T13:30Z), and `/jobs/fixwave-tz` showed "Asia/Tokyo · Fri, Jan 1, 7:30 AM
  GMT+9". Choosing "Server default" and saving deleted the setting row again (0 rows, as before)
  and moved every job back to `America/Chicago`.
- **Run now on a disabled job:** with the job disabled, the page's **Run now** toasted "Run
  started"; run `ece50e5f` → `done`, not suppressed, in main. The job stayed disabled with
  `next_run_at` null and `last_outcome = spoke`.
- **Wake divider:** `/agent` showed "woken · job:fixwave-tz: Final review fix wave check: …",
  and her reply named the job.
- **Cleanup:** `DELETE /api/jobs/fixwave-tz` recorded its final revision (4 revisions), which I
  then removed by id. The four seeds are disabled with byte-identical `content_hash` and
  `America/Chicago`; `agent_timezone` is absent, as it was. The main thread keeps the one wake
  and its reply.

## Deviations from the spec (rulings, all from the SDD ledger)

**Planning rulings**
- **Invalid content is rejected at write time** (UI save and agent tools alike) and never stored
  with `parse_error`. `parse_error` is still written by the boot revalidation pass (for example a
  model removed from the registry), and only that path posts "job X is invalid" to main. The
  reason: storing every invalid keystroke state would spam main.
- **Skills and Jobs pages save explicitly** (a Save button or ⌘S), not with the documents
  autosave.
- **The skills data move runs in an idempotent boot plugin**
  (`server/plugins/agent-skills-migrate.ts`), not in SQL. Rebuilding markdown from jsonb
  frontmatter plus body is fragile in SQL.

**Build rulings**
- **Test seams (T5).** `onRunFinished` and `revalidateAll` take an optional `{ mainConversationId }`,
  so tests never write to the real main thread.
- **The DST fixture in the plan was off by a day (T2)** and was corrected to span the offset
  change.
- **An offset-less `at` is wall-clock time in the job's timezone.** In a DST gap it shifts
  forward; in an overlap it takes the earlier instant.
- **Cron spacing** is the minimum gap over an 8-day window from a fixed Monday reference in the
  job's timezone. The check exits early on the first gap under 5 min, and `revalidateAll` yields
  (`setImmediate`) between jobs. The plan's `0 9,9` example was wrong: duplicates collapse.
- **Skills.**
  - `saveSkillSource(null hash)` is create-only.
  - Delete records a final revision, and delete + undo restores the **original id** with its
    history.
  - The data move has a per-document try/catch and reports the paths it skipped.
- **Plugins were not renamed.** Nitro doesn't await plugins, so a first-boot window of a few
  milliseconds with an empty skills index is accepted.
- **`setJobEnabled` is byte-stable.** The shared frontmatter util does a targeted line replace
  and appends only when the key is absent.
- **Store hardening:**
  - an advisory lock serialises the 50-enabled cap;
  - a lost slug race maps to `ConflictError`;
  - revalidation is guarded by `content_hash`;
  - a note that fails to post doesn't abort the revalidation pass;
  - an unreadable registry means every model counts as known at boot (fail open) but not on
    write (fail closed);
  - the brief and wrap seeds use `context: light`.
- **Outcome rules:**
  - enabling a job resets `consecutive_failures`;
  - Stop and `/clear` aborts don't count toward auto-disable, but wall-clock aborts do;
  - only disabled `at` jobs are pruned, and re-arming one clears `fired_at`;
  - live events publish after commit;
  - main gets a note when an `at` job is disabled without firing.
- **The M7 no-`job_id` guard is defensive** and can't be mutation-killed without a forbidden
  unscoped update. Accepted.
- **Wake runs stream only `state` frames**, with no chunk or user-message frames. An empty
  (whitespace) wake reply is silent too. `steered` carries `cid` and is conversation-scoped.
  **A silent wake persists nothing.** This changes cycle 73, which kept the event row.
- **Specs and plans are frozen records (T7).** Mentions of the removed flag stay in them.
- **The jobs write tools** (`create_job`, `edit_job`, `schedule_wake`) use a catch-all error
  return, and `edit_job` returns a typed `not_found`.
- **Skills and Jobs share the `mm.config.viewMode` cookie**, separate from the documents one,
  and default to split.
- **Revert is disabled while the editor is dirty**, with the hint "save or discard first". There
  is no confirm dialog.
- **The fire-time preview matches the tick.** `nextFireTimes` drops instants outside
  `active_hours`. An `every` preview anchors on the stored `next_run_at`, so Run now no longer
  appears to shift it. The "Not saved" error clears on the next edit.
- **`nextRunAt` returns the first in-hours instant**, from the same bounded scan (a **366-day
  horizon** plus a candidate cap). The stored `next_run_at`, the list, the preview and the tick
  agree, and overnight slots are never claimed or recorded as `skipped`. An `at` job keeps its
  exact time even when it is out of hours, so it can be disabled with a note. An empty preview
  explains itself.
- **`get_job` uses the same anchor as the API.** The list switch disables while its request is
  in flight. A null timezone falls back to the server's default timezone, not the browser's.
- **A `queued` frame** (`{type:'queued',text,cid}`) answers a message that became its own run
  behind a running run, for a wake or for a non-plain message behind an interactive run. The
  client paints the bubble immediately.
- **The runtime is always on.** The `AGENT_RUNTIME` flag and the legacy path are gone, so
  rollback is a code revert to a cycle-73 build **plus the skills un-delete SQL** (final review I5).

**Final review rulings**
- **N1 (final re-review):** `task.due` fires are spaced ≥ 5 min apart per job (from
  `last_run_at`); tasks due inside the gap are deferred with no key recorded and join the next
  batch. Closes a self-feeding loop (a job-fired run creating an overdue task). Cost if wrong: a
  due-task nudge arrives up to 5 min late.
- **I1:** agent-written `at` triggers need ≥ 5 min lead (`MIN_INTERVAL_MS`); ≤ 10 agent-created
  `at` jobs per rolling hour; `run_job` refused (the tool returns an explanation) when the calling
  run is itself job-fired. Cost if wrong: Bridget can't chain jobs from inside a job.
- **I2:** `deleteJob` records a final revision in the delete transaction; `restoreJob` keeps the
  original id and history; undo uses it.
- **I3:** one reused conversation per isolated slug (stable lookup: `agent_runs.session_key`), not
  one per fire. Cost if wrong: an isolated job's history accumulates in one thread (summaries
  handle it).
- **I4:** `fireEvent` skips when `hasActiveRun` (key not inserted, so `task.due` retries next
  tick); `task.due` batches every newly-due task into one fire per tick with an event block
  listing them. Cost if wrong: a single digest instead of per-task wakes.
- **I5:** prod is `Etc/UTC` with no `agent_timezone` setting (checked read-only 2026-09-28). An
  "Agent timezone" field in Settings; changing it re-derives jobs without an explicit timezone.
  Docs gain the rollback un-delete SQL and the timezone step. The controller sets
  `America/Chicago` on prod after deploy, before any seed is enabled. The `agent_runtime` setting
  is absent on prod and the flag was removed in Task 7 — no action.
- **Minors:** fix M1 (divider AND server event text), M2, M3 (run id wired through
  `ToolContext`), M4, M5 (disabling always succeeds), M6 (an enabled past `at` is a validation
  error), M7 (log skipped docs by path), M8 (skill toggle uses `setFrontmatterKey`), M11 (skip
  `onRunFinished` when the finish was fenced).
- **M10 revised:** a human Run now (API/UI) works on a disabled job so Tony can try a seed before
  enabling it; the agent's `run_job` still refuses disabled jobs.
- **M9 parked — a deviation:** spec §11 says `/jobs` shows per-job run counts; only the SQL
  query in the wiki (§ Operational queries) provides them.
- **The M8 byte-stable path is toggle-only.** Any update that changes another field still
  regenerates the markdown from fields (and drops extra frontmatter keys).
- **A skipped `cc.session_end`** (the job's previous run still going) is not retried; that
  session is not digested. `task.due` defers instead, because its source is re-read every tick.

## Follow-ups (every parked item, plus what acceptance found)

1. ~~**Reject unsatisfiable `active_hours` at write.**~~ **Resolved** in the reliability pass ([reliability handover](2026-09-29-bridget-reliability.md)): `writeJob` rejects a cron/every schedule that never fires inside its hours. Today a cron/every job whose hours can never
   match saves with `next_run_at = null` and silently never fires. Its page shows "—" and "no
   fire time falls within active_hours". (Parked in T12.)
2. **A mobile right column on `/skills/[slug]` and `/jobs/[slug]`.** The status and revisions
   panels are hidden below `lg`. (Parked in T11/T12.)
3. ~~**Interrupted runs leave `last_outcome` stale (T5 M2).**~~ **Resolved** ([reliability handover](2026-09-29-bridget-reliability.md)): recovery reports a job run as `failed`, so the streak and the 3-strike disable move. A fix: have `recoverOrphans` call
   `onRunFinished` with a failed outcome for rows that have a `job_id`.
4. ~~**At-most-once across a crash (T5 M3).**~~ **Resolved** ([reliability handover](2026-09-29-bridget-reliability.md)): a failed wake re-arms the `at` job (up to 5 failures) or releases the event fire rows, and a crash sweep repairs what a crash left behind.
   - An event fire row, and an `at` job's claim, both commit before the wake. A crash or a wake
     error between them loses the fire.
   - A crash between the claim and the disable leaves an inert enabled `at` job.
   - A fix: an outbox, or re-arm on a failed wake.
5. ~~**`runJobNow` can race the tick (T5 M5)**~~ **Resolved** ([reliability handover](2026-09-29-bridget-reliability.md)) with a partial unique index (one active run per job) instead of a row lock: and produce two runs. A fix: `select … for update`
   on the job row, and check for overlap inside that transaction.
6. **The queued bubble lingers** until a reload when the queued run ends `interrupted`. An
   attachment-only queued message shows text only until its run starts. (Parked in T6.)
7. **The cron density check** misses day-of-month or month-restricted patterns that are dense
   only outside its fixed 8-day window, for example `0,3 9 1,2 1 *`. (T2 minor.)
8. **Skills write + revision is not one transaction.** The default revision actor differs
   between create and update. `listSkills` sorts twice. (T3 minors.) Jobs do the write and the
   revision in one transaction.
9. **No concurrent-CAS WHERE test for jobs (T4 minor).** Mixed per-line endings are normalised
   to the fence's separator, and the absent-key fallback normalises the frontmatter to LF.
10. **The not-fired note says "turned off"** even if the disable that ran without waiting failed.
    (T5 minor.)
11. **`run_job`'s success path is not DB-tested.** There is no `wakeFn` seam on the tool; the
    Task 5 tests cover the fire path. (T8 minor.)
12. **HTTP nits (T9 minors).**
    - The revert routes don't validate `revisionId` as a UUID, so the 400 carries the raw PG
      message.
    - The skills source PUT returns 200 on create.
    - A revert to another target's revision returns 400, not 404.
13. **`CodeLanguage` is defined three times.** (T10 minor; the stale toolbar comment was fixed in
    T11.)
14. ~~The job divider label shows `job`, not the slug.~~ Fixed in the final review fix wave (M1).
15. ~~`eventBlock` doubles the full stop.~~ Fixed in the final review fix wave (M2).
16. **The pre-existing triage/undo DB tests leak 14 soft-deleted task rows** per `pnpm test:db`
    run, confirmed again today. (Noted in T5.)
17. **The wiki mirror to MyMind** for `agent-jobs`, `agent-runtime` and `agent-skills` is left to
    the controller. (T7 concern.)
18. **Per-job run counts on `/jobs`** (spec §11, final review M9): parked; use the wiki query.
19. **`agent_runs.session_key` has no index.** The isolated-thread lookup scans it; fine at
    today's volume.
20. **Final re-review minors (parked).**
    - Changing `agent_timezone` re-arms every `every` job from now, so an `every 1d` job can slip
      up to a day.
    - The hourly cap counts only newly created agent `at` jobs; the 5-min lead is what bounds
      re-arming an existing one.
    - A silent `schedule_wake` into an isolated thread still leaves an empty thread on its first
      fire.
    - The M11 test waits on a fixed 300 ms sleep.
    - A restored job loses its `agent_job_fires` rows, so it re-announces tasks overdue in the
      last 7 days.

**Dev-DB incident (Task 3, repaired).** A mutation check spliced a raw `sql\`true or …\`` into a
drizzle `and()`. It escaped the test scope and migrated 15 real dev skill documents. They were
repaired in a transaction. Nine dev docs that were already soft-deleted stayed deleted but lost
their original `deleted_at`. The rule now lives in the SDD `db-safety.md` and the
`mutation-checks-on-shared-dev-db` memory.

## Deploying (when merged)

1. Take a pre-deploy dump to `/root/db-backups` (not `/opt/mymind`).
2. CD applies **0056**. On first boot:
   - the skills plugin moves prod's skill documents into `agent_skills` (check the
     `[agent-skills-migrate] moved N` log line, and that `/skills` lists them);
   - the runtime plugin installs the four seed jobs, **disabled**.
3. **Set the timezone before enabling any seed.** Prod runs `Etc/UTC` and has no
   `agent_timezone` setting, so `morning-brief` would fire at 07:30 UTC (02:30 CDT). Open
   **Settings → Bridget → Agent timezone**, pick `America/Chicago`, and Save. Saving re-derives
   every job without its own `timezone:` line (the toast says how many), so the order is safe even
   if a job was saved before. Check with
   `select slug, timezone, next_run_at from agent_jobs order by slug;` — every seed should read
   `America/Chicago`. (A raw `insert into settings` skips the re-derive; use the page, or re-save
   it there afterwards.)
4. Tony enables the seeds on `/jobs` (he can try one first with **Run now** while it is still
   disabled). Watch the per-job run counts query in the wiki for heartbeat cost.

**Rolling back** is a redeploy of a cycle-73 build **plus the skills un-delete**: the move
soft-deleted prod's skill documents, and cycle-73 code reads skills only from `documents`. The
exact SQL (preview, un-delete in a transaction, and the list of skills changed after the move,
which exist only in `agent_skills`) is in
[agent-runtime.md § Rollback](../wiki/agent-runtime.md#rollback).

## Where cycle 75 starts

- `deliver` is parsed and stored; only `app` is honoured. Channels (two-way BlueBubbles) plug in
  at `fireJob`/`wake` and the runner's reply path.
- Follow-ups 1, 3, 4 and 5 are the reliability items worth doing before jobs go beyond in-app
  delivery. (All four resolved in the reliability pass: [reliability handover](2026-09-29-bridget-reliability.md).)
