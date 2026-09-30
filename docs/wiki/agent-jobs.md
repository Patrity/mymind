---
title: Agent Jobs (markdown-configured schedules and triggers)
status: shipped  # cycle 74 deployed 2026-09-29; the reliability pass (0059-0062) is built, not deployed
cycle: 74 (`deliver` targets: cycle 75)
updated: 2026-09-30  # cycle 76: digest seed, engagement signals, nightly tuning (built, unmerged)
---

# Agent Jobs

Since cycle 74 Bridget can talk on her own. Every proactive behaviour (morning brief, evening
wrap, Claude Code session digest, a reminder she set herself, the heartbeat) is a **job**: a
markdown file whose YAML frontmatter says *when* and whose body says *what*. The markdown is the
single source of truth. Every column derived from it is recomputed on save and never edited
directly. A job fires by calling the cycle-73 `wake()`; nothing else starts a headless run.

Spec: [`2026-09-28-bridget-jobs-design.md`](../superpowers/specs/2026-09-28-bridget-jobs-design.md) ·
Handover: [`2026-09-28-bridget-jobs.md`](../handovers/2026-09-28-bridget-jobs.md) ·
Related: [agent-runtime.md](agent-runtime.md) (runs, `wake()`, the headless gate),
[agent-skills.md](agent-skills.md) (the sibling markdown config type).

Where this page and the spec disagree, this page describes the code. The build's deviations are
listed in the handover.

## The job file

```markdown
---
trigger: cron 30 7 * * 1-5     # cron <expr> | every <n>m|<n>h | at <ISO datetime> | event <name>
timezone: America/New_York     # IANA; default = Settings → Bridget → Agent timezone, else the server's zone
active_hours: 07:00-23:00      # optional, [start, end), wraps past midnight when end < start
model: default                 # or a registry model id
thread: main                   # main | isolated
context: light                 # light | full
deliver: [auto, imessage]      # app | auto | imessage | email (cycle 75); default [auto]
enabled: true
filter: { project: mymind }    # event jobs only: key/value match on the event payload
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
```

| Key | Default | Rules (`server/lib/agent/jobs/parse.ts`) |
|---|---|---|
| `trigger` | required | `cron <5-field expr>` (croner), `every <n>m` / `every <n>h`, `at <ISO datetime>`, `event cc.session_end` / `event task.due`. |
| `timezone` | `agent_timezone` setting (Settings → Bridget → **Agent timezone**), else `Intl` server zone | Must be a valid IANA zone. Stored resolved on the row; changing the setting re-derives every job without its own `timezone:` line (see [Timezone](#timezone)). |
| `active_hours` | none (always) | `HH:MM-HH:MM`. A `cron`/`every` job whose schedule never fires inside it (within the 366-day horizon) is rejected on write, enabled or not: "active_hours: the schedule never fires inside <start>-<end>". `at` and `event` jobs are exempt. |
| `model` | `default` (the resolver's chain) | Anything else must be a registry model id. |
| `thread` | `main` | `isolated` wakes into **one side thread per slug**, titled `wake: <slug>` and reused fire after fire (see [Scheduling](#scheduling)). |
| `context` | `full` | `light` = the last **4** turns of history (after the summary tier). |
| `deliver` | `[auto]` (cycle 75; was `[app]`) | A non-empty list of `app`, `auto`, `imessage`, `email`. Anything else is a parse error. See [Delivery](#delivery-cycle-75). An **enabled** job may name `imessage`/`email` only while that channel is enabled in Settings → Channels (checked on create, save and enable, not at boot). |
| `enabled` | `false` | Boolean. The UI switch rewrites just this line. |
| `filter` | none | A flat map; values are coerced to strings. |

Unknown keys are rejected. The body must be non-empty and at most **20,000** characters.

**An offset-less `at`** is wall-clock time in the job's timezone. In a DST gap it shifts forward;
in an overlap it takes the earlier instant.

**Guards**, enforced in `store.ts` for human, agent and system writes alike:
- `every` must be at least **5 min**.
- A `cron` is rejected when any two consecutive fire times are less than 5 min apart. This is
  checked over an 8-day window from a fixed Monday in the job's timezone.
- At most **50** jobs may be enabled. An advisory lock serialises the count check, so two
  concurrent enables can't both pass at 49.
- An **enabled `at` job in the past** is rejected (creating, saving or enabling one): it would
  sit enabled forever with no next run. Save it with `enabled: false` instead.

**Wake-rate guards on Bridget's own writes** (actor `agent`, final review I1). The rules above
bound a job's cadence and how many run at once, but not a chain of one-off wakes (each fired
reminder schedules the next; a fired `at` job disables itself and frees its slot) or two jobs that
run each other:
- an `at` time Bridget arms (a create, an enable, or a changed trigger) must be at least
  **5 min** ahead — `schedule_wake("in 1m")` is refused;
- Bridget may create at most **10 `at` jobs per rolling hour**
  (`MAX_AGENT_AT_CREATES_PER_HOUR`). The count is taken from each job's **first revision**
  (`countAgentAtCreatesLastHour`), so deleting reminders or letting them fire does not reset it;
- `run_job` is refused with `refused_in_job_run` when the run calling it was itself fired by a
  job (`agent_runs.job_id` of `ToolContext.runId`), so A→B→A cannot ping-pong.

Human (UI/API) and `system` writes are not subject to these three.

**Invalid content is rejected at write time.** A save or an agent tool call that fails to parse
or breaks a guard gets a 400 (or `{ ok: false, error }` from a tool) with the exact message, and
nothing is stored. `parse_error` is written only by the boot revalidation pass (for example after
a pinned model leaves the registry), and only that path posts "Job X is invalid: … — fix it on
/jobs/X" to main, once per transition from valid to invalid.

## Storage (migration 0056)

`server/db/schema/agent-config.ts`:

| Table | Columns |
|---|---|
| `agent_jobs` | `id`, `slug` (unique, `^[a-z0-9][a-z0-9-]{0,63}$`), `content`, `content_hash` (sha256, the CAS token), `source` (`human`/`agent`). **Derived:** `enabled`, `trigger_kind`, `trigger_expr`, `timezone`, `next_run_at`, `parse_error`. **Runtime:** `last_run_at`, `last_run_id`, `last_outcome` (`spoke`/`silent`/`failed`/`skipped`), `consecutive_failures`, `fired_at` (`at` jobs), `fire_failures` (0060: failed `at` wakes in a row). `created_at`, `updated_at`. Partial index `agent_jobs_due (next_run_at) where enabled and parse_error is null`. |
| `agent_config_revisions` | `target_kind` (`skill`/`job`), `target_id`, `content`, `actor` (`human`/`agent`/`system`), `run_id`, `created_at`. The last **100** per target are kept, pruned on write. No FK: a deleted job's revisions stay until deleted explicitly. |
| `agent_job_fires` | PK `(job_id, event_key)`, `fired_at`, `run_id` (0059: nullable FK to `agent_runs`, `on delete set null`; NULL until the fire's run exists); FK cascade on job delete. It dedupes event fires and the one-per-job "reminder did not fire" note (key `at:not-fired`). |
| `agent_runs.job_id` | Nullable FK, `on delete set null`. Partial unique index `agent_runs_one_active_per_job (job_id) where job_id is not null and status in ('queued','running')` (0059): one active run per job. Plain index `agent_runs_job_created_idx (job_id, created_at)` (0062) for the sweep's "any run since" checks and `listRuns({ jobId })`. |

`agent_skills` is in the same migration; see [agent-skills.md](agent-skills.md).

## Modules — `server/lib/agent/jobs/`

| File | Responsibility |
|---|---|
| `parse.ts` | Markdown → `JobSpec` or `{ error }`. Pure. |
| `schedule.ts` | `nextRunAt`, `nextFireTimes`, `describeTrigger` ("weekdays at 7:30"), `inActiveHours`, `resolveAtInstant`, `minCronGapMs`. Pure, croner-based and DST-safe. |
| `store.ts` | **The only writer of `agent_jobs`.** `createJob`, `saveJob` (CAS), `setJobEnabled`, `deleteJob` (records a final revision), `restoreJob` (re-creates under the original id), `revertJob`, `revalidateAll` (boot), `rederiveDefaultTimezone`, `installSeedJobs`, `countAgentAtCreatesLastHour`. |
| `tick.ts` | `jobsTick` (claims due jobs and fires them), `runJobNow`, `fireJob`, `hasActiveRun`, `sweepCrashedFires` (crash recovery). |
| `events.ts` | `fireEvent(name, key, payload)`, `dueTaskEvents()` and `eventBlock()` (the plain-sentence event description appended to the prompt). |
| `outcome.ts` | `onRunFinished`, called by `queue.ts` `execute` after every run: writes `last_outcome` and the failure streak, and auto-disables. |
| `seeds.ts` | The four seed job files (`SEED_JOBS`), plus `SEED_JOBS_V1`, the cycle-74 content byte for byte, which `upgradeSeedJobs` matches against. |
| `wake-time.ts` | `schedule_wake`'s `when` parser. |
| `timezone.ts` | `getDefaultTimezone()`, `serverTimezone()`, `getAgentTimezoneSetting()` / `setAgentTimezoneSetting()`. |

**Every write** follows the same order: parse (reject on failure), derive columns (`next_run_at`
only while enabled), enabled-count guard, CAS on `content_hash` inside the UPDATE (zero rows means
409 with the current content), record a revision, then `publishChange('agentJob')`. Re-enabling a
job resets `consecutive_failures`. Re-arming an `at` job with a future time clears `fired_at`.

**`source`** is who authored the current content: a `human` or `agent` write sets it, while a
`system` write (the tick disabling a fired `at` job, the failure auto-disable, a seed install)
keeps it. A reminder Bridget scheduled keeps its `agent` badge after it fires; a human edit
relabels it `human`.

**`setJobEnabled`** rewrites only the `enabled:` line (`shared/utils/frontmatter.ts`
`setFrontmatterKey`, a targeted line replace). Every other byte is unchanged, so enabling and then
disabling a job returns its exact original `content_hash`. Enabling goes through the full write
path. **Disabling always succeeds**: it skips re-validation (a job pinned to a model that has
left the registry, or any pinned job while the registry is unreadable, can still be switched off
— by the UI, the `at` self-disable or the 3-failure auto-disable) and changes only the content,
`enabled`, `next_run_at` and `source`, still under CAS and with a revision.

**`deleteJob`** deletes the row and records its final content as a revision (actor and run id)
in the same transaction, so a delete shows in history. **`restoreJob(priorId, slug, content)`**
re-creates it under its **original id** through the normal write path, so the revision history
(keyed by that id) is whole again; `delete_job`'s undo uses it. Fire rows (`agent_job_fires`,
cascade) and `agent_runs.job_id` links (set null) do not come back.

## Scheduling

`next_run_at` is **the first instant the job will actually fire**:
- `cron` and `every` return the first candidate inside `active_hours`. The scan jumps straight
  to the next window start instead of stepping through the night, and is bounded by a
  **366-day horizon** and a candidate cap.
- A cron or every job whose `active_hours` can never match is **rejected on write** (create,
  save, enable, revert, restore) with "active_hours: the schedule never fires inside
  <start>-<end>" (`activeHoursNeverMatchError` in `schedule.ts`, called by `writeJob`), whether
  it is enabled or not. A schedule with no fire time in the horizon even without the hours (for
  example `0 9 29 2 *`) is not blamed on the window and still saves. Boot `revalidateAll` does not
  run this check, so a job saved before it existed keeps `next_run_at = null`, and its page shows
  "—" and "no fire time falls within active_hours".
- `at` returns its exact instant even when it is outside the hours, so the tick still claims it,
  disables it and leaves the did-not-fire note.
- `event` returns null.

The list, the detail page's preview, the `get_job` tool and the tick all use these same functions.
The preview (`nextFireTimes(spec, 5, now, { anchor })`) anchors an **`every`** job on its stored
`next_run_at` while enabled, because the cadence runs from the last fire, not from page load. Cron
and `at` are wall-clock and ignore the anchor.

**The tick** (`jobsTick`, run from the cycle-73 `workerTick` every 5 s, unscoped production ticks
only, followed by `dueTaskEvents()`):
1. One transaction: `select … where enabled and parse_error is null and next_run_at <= now()
   order by next_run_at for update skip locked limit 10`. For each row it sets `last_run_at` and
   computes the new `next_run_at` **from now**. That gives a single catch-up after downtime, with
   no burst. An `at` row gets `next_run_at = null` and `fired_at = now`. Claiming and advancing
   in one transaction makes the claim exactly-once across processes.
2. For each claimed job it re-parses the stored content, then:
   - if it no longer parses → `skipped`;
   - if it is outside `active_hours` → `skipped` (a guard only, because `next_run_at` is already
     in hours);
   - if its previous run is still `queued`/`running` → `skipped` (this check is a fast path;
     see **Overlap and crash recovery**);
   - otherwise `fireJob` → `wake({ reason: 'job:<slug>', prompt: body, sessionKey: 'main' |
     'isolated:<slug>', model, jobId, context })`, which sets `last_run_id`. An `isolated:<slug>`
     key resolves to **the thread its newest run used** (`runtime/sessions.ts`): the stable key
     is `agent_runs.session_key`, which every run records alongside its thread, and runs are
     never pruned. Only the first fire (or one after Tony deletes the thread) creates it, so a
     silent heartbeat on `thread: isolated` does not leave an empty thread per fire.
3. If the wake **throws**, an `at` job's claim is undone instead (`fired_at` null, `next_run_at`
   back to its instant, still enabled, no note) and the next tick retries it. Each failed wake
   (and each crash the sweep repairs) adds one to `fire_failures`. At **5** in a row
   (`MAX_FIRE_FAILURES`) the job gives up: it is disabled with the did-not-fire note ("waking it
   failed 5 times in a row (…)"). Creating a run resets the count to 0, and so does re-arming
   the job. Re-arming also deletes the job's `at:not-fired` row, so a re-armed reminder that
   gives up again gets its note again.
   Otherwise an `at` job is then disabled with a **system** revision (`setJobEnabled(slug, false,
   'system')`). If it did not fire, one note goes to main: "Reminder X did not fire: … It is now
   turned off; re-arm it on /jobs/X".
4. Disabled `at` jobs fired more than **30 days** ago are deleted with their revisions.

**Run now** (`runJobNow`, the UI button and the `run_job` tool) fires immediately and leaves the
schedule alone. It returns `{ skipped: 'invalid' | 'overlap' }` instead of firing when those
apply. A **human** Run now (`POST /api/jobs/:slug/run`, `allowDisabled: true`) also works on a
**disabled** job, so a seed can be tried before it is enabled; the agent's `run_job` still gets
`skipped: 'disabled'`.

## Timezone

The zone a job uses when its file names none is the `agent_timezone` setting, set in **Settings →
Bridget → Agent timezone** (`app/components/settings/AgentTimezone.vue`; an IANA select with a
"Use browser timezone" shortcut and a "Server default" option that clears the setting). With no
setting it is the server process's `Intl` zone (prod runs `Etc/UTC`).

Each job row stores the zone it resolved when it was saved, and the tick passes `row.timezone`
back as the default. So `PUT /api/settings/agent-timezone` calls **`rederiveDefaultTimezone()`**
after writing the setting: every job whose file has no `timezone:` line gets the new zone and,
when enabled and valid, a `next_run_at` recomputed from now. Content is untouched (no revision),
and each update is guarded by `content_hash`. A job with its own `timezone:` never moves.
Changing the setting row by raw SQL skips this step; re-save the setting from the page instead.

## Events

| Event | Source | Key | Payload |
|---|---|---|---|
| `cc.session_end` | `POST /api/hooks/cc/SessionEnd` (fire-and-forget after the session upsert) | session id | `sessionId`, `title`, `project` (canonical slug), `durationMinutes`, `summary` |
| `task.due` | `dueTaskEvents()` on every worker tick | `task:<id>:<due ISO>` (one per task) | `tasks: [{ taskId, title, dueDate }]` (one fire per job per tick) |

`task.due` covers tasks with `due_date <= now()` that are not completed or deleted and fell due
within the last **7 days**. Moving a task's due date makes it a new event. When no enabled job
listens for `task.due`, the tasks query is skipped.

`fireEvent` loads enabled, valid jobs whose trigger is `event <name>`, applies `filter`
(string-equal on each key), **skips a job whose previous run is still queued or running** (spec
§4's no-self-overlap rule — nothing piles up on main; the key is not recorded, so that session's
digest is simply not made), then inserts `(job_id, key)` into `agent_job_fires`. Only a job whose
insert landed wakes. A repeated hook delivery fires nothing.

**`task.due` is batched.** `dueTaskEvents()` fires each listening job **at most once per tick**,
with one event block listing every task newly due for it ("3 tasks are due and not completed yet:
'A', due … (task id …); …" — a single task reads as the one-task sentence). Dedupe stays per task:
one `agent_job_fires` row per `(job, task:<id>:<due ISO>)`, so a task never re-fires. A job whose
previous run is still going is skipped **without** recording any key, so those tasks join the
next tick's batch. A job that fired less than 5 minutes ago (`MIN_INTERVAL_MS`, measured
from `last_run_at`) is also deferred the same way, so a job-fired run that creates an overdue task
cannot re-fire its own job on the next tick. The prompt is the body plus a blank
line plus `eventBlock()`, a plain sentence with no brackets (the model imitates markers). Once the
run exists its id is written to the fire rows' `run_id`. A wake that **throws** marks the job
`failed`, stamps `last_run_at` and deletes the fire rows it just inserted, so the key can fire
again (`task.due` retries once the 5-minute gap has passed; `cc.session_end` only on a
redelivery). An overlap deletes them the same way.

## Overlap and crash recovery

**Overlap is enforced by the database.** `agent_runs_one_active_per_job` allows one
queued-or-running run per job. Every fire path (`jobsTick`, `fireEvent`, `dueTaskEvents`,
`runJobNow` and so the `run_job` tool) keeps its `hasActiveRun` pre-check as a fast path, but a
fire that races another fire of the same job fails its run insert (23505 on that index), and
`fireJob` returns `{ overlap: true }`. It is then handled as the ordinary overlap skip for that
path, never as an error (`runJobNow` → `{ skipped: 'overlap' }`).

**Crash sweep.** `sweepCrashedFires()` runs first in every unscoped `workerTick` and repairs
what a crash left half-done (older than **2 minutes**):
- an enabled `at` job with `fired_at` set and no run of it created since → re-armed as above and counted toward the 5-failure
  cap (the UPDATE re-checks every condition, staleness included, so two sweeps cannot both
  re-arm it), and logged;
- an enabled `at` job with `fired_at` set whose run **was** created since (the crash hit between
  the fire and the tick's self-disable) → disabled with a system revision, no note (it did fire),
  and logged. The disable is pinned to the content hash the sweep read, so a re-arm since wins;
- an `event` job's fire row with `run_id` NULL (fired within the last 24 h) and no run of its job
  created since → deleted, and
  logged. `task.due` re-fires on the next tick. A lost `cc.session_end` cannot be re-fired (the
  payload is gone); the delete only frees its key for a redelivery.

It is idempotent, and `onlySlugs`/`now` are its test seams.

## Outcomes and failures

`onRunFinished` maps the run's outcome onto the job:

| Run outcome | `last_outcome` | Failure streak |
|---|---|---|
| `done`, not suppressed | `spoke` | reset to 0 |
| `done`, suppressed (`NO_REPLY` or an empty reply) | `silent` | reset to 0 |
| `failed`, or `aborted` by the 5 min headless wall clock | `failed` | +1 |
| `aborted` by Tony (Stop, `/clear`) | `failed` | unchanged |

**An interrupted run counts as a failure.** `recoverOnBoot` and `recoverStale` call
`onRunFinished(run, { status: 'failed', error: 'interrupted by a restart' })` for every run they
recover, so `last_outcome`, the streak and the 3-strike disable all move (a job run killed by
restarts three times in a row is turned off). Tony's Stop is never recovered (it ends `aborted`
in its own process), so it still does not count.

`execute` skips `onRunFinished` when `finishRun` was **fenced** (the row was no longer `running`:
another process recovered it as `interrupted` while this one still ran it), so the job never
records `spoke`/`silent` for a run whose row says `interrupted`.

After **3** consecutive counted failures the job is disabled (system revision) and main gets
"Job X failed 3 times in a row, so I turned it off. The last error was: … Re-enable it on
/jobs/X once it is fixed."

**A silent run leaves nothing in the thread** (spec D4): no event row, no assistant row, no
`persisted` frame. Its `agent_runs` row (`suppressed = true`) is the only trace, visible in the
Runs drawer as "silent" and in the job's Recent runs.

| Failure | Behaviour |
|---|---|
| Invalid content on save | 400 with the parse error; nothing stored |
| Content that becomes invalid (boot revalidation) | `parse_error` set, `next_run_at` null, one note in main |
| Run fails | `failed`, schedule continues, streak +1 |
| 3 in a row | auto-disable plus a note in main |
| Server down past a due time | fires once on the first tick, then reschedules from now |
| CAS conflict | 409 with `data.current = { content, contentHash }`; the editor shows the conflict |
| Rate guard | 400 / tool `ok: false` with the reason |

## Seed jobs

`installSeedJobs()` runs on every boot (`server/plugins/agent-runtime.ts`, before the worker
starts). It installs a slug only if it is missing, always **disabled**, with actor `system`.
**Tony enables them from `/jobs`.**

| Slug | Trigger | Notes |
|---|---|---|
| `morning-brief` | `cron 30 7 * * 1-5` | `context: light`, `deliver: [auto, imessage]` |
| `evening-wrap` | `cron 0 21 * * *` | `context: light`, `deliver: [auto]` |
| `heartbeat` | `every 30m`, `active_hours: 08:00-22:00` | `context: light`, `deliver: [auto]`; checklist body; `NO_REPLY` when nothing needs attention |
| `session-digest` | `event cc.session_end` | `thread: main`, `context: light`, `deliver: [app]`; "Propose tasks rather than creating duplicates" |
| `self-improvement-digest` (cycle 76) | `cron 30 21 * * *` | `context: light`, `deliver: [auto]`; lists today's `agent_improvements` via `list_improvements`, `NO_REPLY` when none. Born with its `deliver:` line, so it has no V1 and is never upgraded |

**Seed upgrade (cycle 75).** `upgradeSeedJobs()` runs on boot right after `installSeedJobs()`. It
moves a seed from its cycle-74 content (`SEED_JOBS_V1`) to the current one, which adds the
`deliver:` lines. It is hash-guarded: only a seed whose stored content is exactly its previous
version, or that version with just `enabled: true` switched on, is rewritten (actor `system`, CAS),
and an enabled seed stays enabled. Any other edit is left alone, and a second boot is a no-op. An
enabled seed whose new `deliver` names a channel that isn't set up stays at its previous version
with a warning until the channel is configured.

The seeds name no `timezone:`, so they follow the Agent timezone setting (see [Timezone](#timezone)),
or the server zone when it is absent. On the dev box that is `America/Chicago`; **prod runs
`Etc/UTC`, so set the Agent timezone before enabling any seed.**

## Self-improvement: signals and nightly tuning (cycle 76, built)

Every job message a run posts opens a 2 h observation window. Tony's reply, stop/thanks words, a
tapback, or silence (`ignored`) becomes an `agent_signals` row. A nightly pass (hourly tick,
running once a day from 03:00 agent time) shows the reflector each enabled job with **≥ 5
signals in 14 days**. It may propose `job.edit` or `job.disable`:

- `job.edit` of an agent-authored job may auto-apply (CAS on the hash read before the call);
- a Tony-authored job, any change to `enabled`, and every `job.disable` go to `/review`;
- evidence must quote the job's own signal snippets.

See [self-improvement.md](self-improvement.md).

## Delivery (cycle 75)

A job's reply always lands in its thread in the app. `deliver` says where **else** it goes. This
is resolved when the run finishes (`server/lib/channels/deliver.ts` `resolveDeliverChannels` and
`planDeliveries`), in the same transaction as the reply:

| Value | Effect |
|---|---|
| `app` | Nothing outbound. |
| `auto` | iMessage to the default handle, **only while Tony is away** from the app (no activity ping for `presence_away_minutes`, default 10). Never email. |
| `imessage` | iMessage to the default handle, always. |
| `email` | Email to Settings → Channels → Email **Send to**, always, with subject **`Bridget · <slug>`**. |

- **No `deliver:` line means `[auto]`** (preflight ruling 3; it was `[app]` in cycle 74). An
  enabled custom job without the line may start texting Tony when he is away.
- A silent or empty reply delivers nothing. A channel that is disabled when the run finishes is
  skipped with an activity `warn` (`channels:deliver-skipped`); so is iMessage with no default
  handle.
- A job run that also has `reply_to` (a steered iMessage) sends one iMessage, not two.
- Delivery status shows as badges under the reply in `/agent`, and a delivery that finally fails
  posts an event note on main. The outbox, retries and duplicate check are in
  [channels.md](channels.md).
- The UI: the job status panel shows **Delivers to** (for example "App · Email",
  `app/lib/jobs/deliver-label.ts`), and the **New job** templates carry a `deliver:` line.

## Agent tools

In `server/lib/agent/tools/jobs.ts`, registered in `agentTools`, so they are also exposed on MCP
(`/api/mcp`, which skips only `dangerous` tools).

| Tool | Kind | Headless class | Notes |
|---|---|---|---|
| `list_jobs` | read | run | slug, enabled, description, next run, last outcome |
| `get_job` | read | run | content, status and the next 5 fire times (same anchor as the API) |
| `create_job` | create | run | `{ slug, content }` |
| `edit_job` | create | run | `old_string`/`new_string` (+ `replace_all`) like `edit_document`, or `content` for a full replacement |
| `delete_job` | destructive | **run** (`FREE_TOOLS`) | Job upkeep is Bridget's own (spec D2). Records a final revision (actor `agent`, the run id); undo = `restoreJob`, same id and history |
| `run_job` | create | run | `not_found` / `overlap` / `disabled` / `invalid` on skip; `refused_in_job_run` inside a job-fired run |
| `schedule_wake` | create | run | `{ when, prompt, thread? }` creates `reminder-<6 hex>`, an enabled `at` job with `context: light`. `when` is an ISO datetime (offset-less = default timezone), `in <n>m\|h\|d`, or `today\|tomorrow HH:MM`. It must be at least **5 min** ahead, and at most **10** per rolling hour (see Guards). |

Every failure returns `{ ok: false, error }` and never throws. Agent writes record revisions
with actor `agent` and the **run id** — `ToolContext.runId`, which the runtime runner threads
through `handleTurn` → `runAgent` → `buildAiTools`. A call from MCP has no run, so its revisions
carry a null `run_id`.

## HTTP API

| Route | Behaviour |
|---|---|
| `GET /api/jobs` | `JobDTO[]` ordered by slug |
| `POST /api/jobs` `{ slug, content }` | create, 201; 409 if the slug exists; 400 when invalid |
| `GET /api/jobs/:slug` | `{ job, nextFireTimes (5), runs (last 10: status, suppressed, durationMs, conversationId, assistantMessageId) }` |
| `PUT /api/jobs/:slug` `{ content, expectedHash }` | CAS save; 409 `{ current }`; 404; 400 |
| `DELETE /api/jobs/:slug` | delete; records a final `human` revision (revisions stay) |
| `PUT /api/jobs/:slug/enabled` `{ enabled }` | rewrites the `enabled:` line |
| `POST /api/jobs/:slug/run` | `{ runId }` or `{ skipped }`; runs a disabled job too |
| `GET /api/jobs/:slug/revisions` | newest first |
| `POST /api/jobs/:slug/revert` `{ revisionId }` | restores as a new revision |

| `GET /api/settings/agent-timezone` | `{ timezone (setting or null), effective, server }` |
| `PUT /api/settings/agent-timezone` `{ timezone: string \| null }` | sets (IANA, else 400) or clears the setting, then `rederiveDefaultTimezone()`; returns the GET shape plus `rederived` |

A malformed slug returns 400 before any query (`server/utils/agent-config-http.ts`, shared with
the skill-source routes).

## UI

- **Main nav:** Skills and Jobs (`app/layouts/default.vue`).
- **`/jobs`** (`app/pages/jobs/index.vue`) is a table with the job slug (with an `agent` badge when Bridget wrote it), the
  trigger in plain English, the next run (relative, with the absolute time as a tooltip), the last
  outcome and its time, and an enabled switch. The switch is disabled while its request is in
  flight. Invalid rows are flagged. **New job** takes a slug and a template (Morning brief,
  Heartbeat, Event digest, Blank). Every template starts disabled.
- **`/jobs/[slug]`** (`app/pages/jobs/[slug].vue`) puts the shared `MarkdownConfigEditor` (raw
  CodeMirror with frontmatter highlighting, preview, split) next to `JobStatusPanel` and
  `RevisionsPanel`:
  - the status panel shows Valid/Invalid with the exact error, the schedule in plain English
    with its timezone, the next 5 fire times, **Run now**, and the last 10 runs (outcome, age,
    duration, "view in thread" or "silent");
  - the revisions panel shows each revision's diff against its predecessor, with **Revert**.
- **Saving is explicit:** a Save button or ⌘S, not autosave. A rejected save shows "Not saved"
  with the parser's message, which clears on the next edit. Revert is disabled while the editor
  is dirty ("Save or discard your edits first."). A `beforeunload` guard protects unsaved edits.
- The view mode (edit / split / preview) persists in the `mm.config.viewMode` cookie. It is
  shared with `/skills` and separate from the documents page's cookie.
- **Live:** `publishChange` resource `agentJob` invalidates `['jobs']`. A job-fired run finishing
  publishes it too, so outcomes appear without a reload.
- In the transcript a fired job shows as the wake divider, **"woken · job:<slug>: …"**, followed
  by her reply. The origin is split on its first colon only (`shared/utils/event-origin.ts`
  `splitOrigin`, shared with the server's `eventModelText`, which reads "Background wake
  (job:<slug>): …" to the model). Only `state` frames stream live during a wake.
- **Settings → Bridget** carries the **Agent timezone** field (see [Timezone](#timezone)).
- The status panel shows **Delivers to** from the parsed `deliver` list (cycle 75).
- **Per-job run counts are not on `/jobs`** (spec §11 asked for them): use the per-job run
  count query below. A recorded deviation.

## Operational queries

```sql
-- every job, its schedule and health
select slug, enabled, trigger_kind, trigger_expr, timezone, next_run_at, last_outcome,
       consecutive_failures, parse_error from agent_jobs order by slug;

-- what is due right now (the tick should drain this within 5 s)
select slug, next_run_at from agent_jobs
where enabled and parse_error is null and next_run_at <= now();

-- a job's recent runs and whether she spoke
select r.created_at, r.status, r.suppressed, r.error from agent_runs r
join agent_jobs j on j.id = r.job_id where j.slug = 'heartbeat' order by r.created_at desc limit 20;

-- run counts per job over the last day (heartbeat cost drift)
select j.slug, count(*) from agent_runs r join agent_jobs j on j.id = r.job_id
where r.created_at > now() - interval '1 day' group by 1 order by 2 desc;

-- a job's revision history
select created_at, actor, run_id from agent_config_revisions
where target_kind = 'job' and target_id = (select id from agent_jobs where slug = 'heartbeat')
order by created_at desc;

-- engagement signals per job over the tuning window (cycle 76)
select j.slug, s.kind, count(*) from agent_signals s join agent_jobs j on j.id = s.job_id
where s.created_at > now() - interval '14 days' group by 1, 2 order by 1, 2;

-- event dedupe rows
select j.slug, f.event_key, f.fired_at from agent_job_fires f join agent_jobs j on j.id = f.job_id
order by f.fired_at desc limit 20;
```

## Known limits

- **A job saved before the active_hours write check** (reliability pass, 2026-09-30) whose hours
  can never match still sits with `next_run_at = null` ("—" on the page) until it is next saved.
  Any save of it, even one through the editor that only sets `enabled: false`, is rejected until
  the hours or trigger are fixed. Use the **enable switch** (`setJobEnabled`, which skips
  re-validation) to turn such a job off.
- **A `cc.session_end` lost to a crash** is not re-fired (see Overlap and crash recovery).
- **The cron density check** looks at a fixed 8-day window, so a day-of-month or month-restricted
  pattern that is dense only outside that window slips through.
- **Revisions have no FK.** Deleting a job leaves its revisions (so `restoreJob` can bring them
  back), and the 30-day `at` prune deletes them explicitly.
- **The isolated-thread lookup** scans `agent_runs.session_key`, which has no index. Fine at
  today's volume; add one if `agent_runs` grows large. Two racing FIRST fires of one isolated
  job could each open a thread; the newest run's thread wins afterwards.
- **A skipped `cc.session_end`** (the job's previous run still going) is not retried: that
  session is simply not digested.
