---
title: Agent Jobs (markdown-configured schedules and triggers)
status: built
cycle: 74
updated: 2026-09-28
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
timezone: America/New_York     # IANA; default = settings `agent_timezone`, else the server's zone
active_hours: 07:00-23:00      # optional, [start, end), wraps past midnight when end < start
model: default                 # or a registry model id
thread: main                   # main | isolated
context: light                 # light | full
deliver: [app]                 # stored; only 'app' exists until cycle 75
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
| `timezone` | `agent_timezone` setting, else `Intl` server zone | Must be a valid IANA zone. Stored resolved on the row. |
| `active_hours` | none (always) | `HH:MM-HH:MM`. |
| `model` | `default` (the resolver's chain) | Anything else must be a registry model id. |
| `thread` | `main` | `isolated` wakes into a fresh thread titled `wake: <slug>`. |
| `context` | `full` | `light` = the last **4** turns of history (after the summary tier). |
| `deliver` | `[app]` | A string array, stored only. |
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

**Invalid content is rejected at write time.** A save or an agent tool call that fails to parse
or breaks a guard gets a 400 (or `{ ok: false, error }` from a tool) with the exact message, and
nothing is stored. `parse_error` is written only by the boot revalidation pass (for example after
a pinned model leaves the registry), and only that path posts "Job X is invalid: … — fix it on
/jobs/X" to main, once per transition from valid to invalid.

## Storage (migration 0056)

`server/db/schema/agent-config.ts`:

| Table | Columns |
|---|---|
| `agent_jobs` | `id`, `slug` (unique, `^[a-z0-9][a-z0-9-]{0,63}$`), `content`, `content_hash` (sha256, the CAS token), `source` (`human`/`agent`). **Derived:** `enabled`, `trigger_kind`, `trigger_expr`, `timezone`, `next_run_at`, `parse_error`. **Runtime:** `last_run_at`, `last_run_id`, `last_outcome` (`spoke`/`silent`/`failed`/`skipped`), `consecutive_failures`, `fired_at` (`at` jobs). `created_at`, `updated_at`. Partial index `agent_jobs_due (next_run_at) where enabled and parse_error is null`. |
| `agent_config_revisions` | `target_kind` (`skill`/`job`), `target_id`, `content`, `actor` (`human`/`agent`/`system`), `run_id`, `created_at`. The last **100** per target are kept, pruned on write. No FK: a deleted job's revisions stay until deleted explicitly. |
| `agent_job_fires` | PK `(job_id, event_key)`, `fired_at`; FK cascade on job delete. It dedupes event fires and the one-per-job "reminder did not fire" note (key `at:not-fired`). |
| `agent_runs.job_id` | Nullable FK, `on delete set null`. |

`agent_skills` is in the same migration; see [agent-skills.md](agent-skills.md).

## Modules — `server/lib/agent/jobs/`

| File | Responsibility |
|---|---|
| `parse.ts` | Markdown → `JobSpec` or `{ error }`. Pure. |
| `schedule.ts` | `nextRunAt`, `nextFireTimes`, `describeTrigger` ("weekdays at 7:30"), `inActiveHours`, `resolveAtInstant`, `minCronGapMs`. Pure, croner-based and DST-safe. |
| `store.ts` | **The only writer of `agent_jobs`.** `createJob`, `saveJob` (CAS), `setJobEnabled`, `deleteJob`, `revertJob`, `revalidateAll` (boot), `installSeedJobs`. |
| `tick.ts` | `jobsTick` (claims due jobs and fires them), `runJobNow`, `fireJob`, `hasActiveRun`. |
| `events.ts` | `fireEvent(name, key, payload)`, `dueTaskEvents()` and `eventBlock()` (the plain-sentence event description appended to the prompt). |
| `outcome.ts` | `onRunFinished`, called by `queue.ts` `execute` after every run: writes `last_outcome` and the failure streak, and auto-disables. |
| `seeds.ts` | The four seed job files. |
| `wake-time.ts` | `schedule_wake`'s `when` parser. |
| `timezone.ts` | `getDefaultTimezone()`. |

**Every write** follows the same order: parse (reject on failure), derive columns (`next_run_at`
only while enabled), enabled-count guard, CAS on `content_hash` inside the UPDATE (zero rows means
409 with the current content), record a revision, then `publishChange('agentJob')`. Re-enabling a
job resets `consecutive_failures`. Re-arming an `at` job with a future time clears `fired_at`.

**`setJobEnabled`** rewrites only the `enabled:` line (`shared/utils/frontmatter.ts`
`setFrontmatterKey`, a targeted line replace). Every other byte is unchanged, so enabling and then
disabling a job returns its exact original `content_hash`.

## Scheduling

`next_run_at` is **the first instant the job will actually fire**:
- `cron` and `every` return the first candidate inside `active_hours`. The scan jumps straight
  to the next window start instead of stepping through the night, and is bounded by a
  **366-day horizon** and a candidate cap.
- A cron or every job whose `active_hours` can never match gets `next_run_at = null`. The
  save is not rejected. The page shows "—" and "no fire time falls within active_hours" (see
  Known limits).
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
   - if its previous run is still `queued`/`running` → `skipped`;
   - otherwise `fireJob` → `wake({ reason: 'job:<slug>', prompt: body, sessionKey: 'main' |
     'isolated:<slug>', model, jobId, context })`, which sets `last_run_id`.
3. An `at` job is then disabled with a **system** revision (`setJobEnabled(slug, false,
   'system')`). If it did not fire, one note goes to main: "Reminder X did not fire: … It is now
   turned off; re-arm it on /jobs/X".
4. Disabled `at` jobs fired more than **30 days** ago are deleted with their revisions.

**Run now** (`runJobNow`, the UI button and the `run_job` tool) fires immediately and leaves the
schedule alone. It returns `{ skipped: 'disabled' | 'invalid' | 'overlap' }` instead of firing
when those apply.

## Events

| Event | Source | Key | Payload |
|---|---|---|---|
| `cc.session_end` | `POST /api/hooks/cc/SessionEnd` (fire-and-forget after the session upsert) | session id | `sessionId`, `title`, `project` (canonical slug), `durationMinutes`, `summary` |
| `task.due` | `dueTaskEvents()` on every worker tick | `task:<id>:<due ISO>` | `taskId`, `title`, `dueDate` |

`task.due` covers tasks with `due_date <= now()` that are not completed or deleted and fell due
within the last **7 days**. Moving a task's due date makes it a new event. When no enabled job
listens for `task.due`, the tasks query is skipped.

`fireEvent` loads enabled, valid jobs whose trigger is `event <name>`, applies `filter`
(string-equal on each key), then inserts `(job_id, key)` into `agent_job_fires`. Only a job whose
insert landed wakes. A repeated hook delivery fires nothing. The prompt is the body plus a blank
line plus `eventBlock()`, a plain sentence with no brackets (the model imitates markers). Events
are **at-most-once**: a wake failure after the fire row landed is logged and marks the job
`failed`, but is not retried.

## Outcomes and failures

`onRunFinished` maps the run's outcome onto the job:

| Run outcome | `last_outcome` | Failure streak |
|---|---|---|
| `done`, not suppressed | `spoke` | reset to 0 |
| `done`, suppressed (`NO_REPLY` or an empty reply) | `silent` | reset to 0 |
| `failed`, or `aborted` by the 5 min headless wall clock | `failed` | +1 |
| `aborted` by Tony (Stop, `/clear`) | `failed` | unchanged |

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
| `morning-brief` | `cron 30 7 * * 1-5` | `context: light` |
| `evening-wrap` | `cron 0 21 * * *` | `context: light` |
| `heartbeat` | `every 30m`, `active_hours: 08:00-22:00` | `context: light`; checklist body; `NO_REPLY` when nothing needs attention |
| `session-digest` | `event cc.session_end` | `thread: main`, `context: light`; "Propose tasks rather than creating duplicates" |

The timezone is the `agent_timezone` setting, or the server zone when that setting is absent. On
the dev box that is `America/Chicago`.

## Agent tools

In `server/lib/agent/tools/jobs.ts`, registered in `agentTools`, so they are also exposed on MCP
(`/api/mcp`, which skips only `dangerous` tools).

| Tool | Kind | Headless class | Notes |
|---|---|---|---|
| `list_jobs` | read | run | slug, enabled, description, next run, last outcome |
| `get_job` | read | run | content, status and the next 5 fire times (same anchor as the API) |
| `create_job` | create | run | `{ slug, content }` |
| `edit_job` | create | run | `old_string`/`new_string` (+ `replace_all`) like `edit_document`, or `content` for a full replacement |
| `delete_job` | destructive | **run** (`FREE_TOOLS`) | Job upkeep is Bridget's own (spec D2) |
| `run_job` | create | run | `not_found` / `overlap` / `disabled` / `invalid` on skip |
| `schedule_wake` | create | run | `{ when, prompt, thread? }` creates `reminder-<6 hex>`, an enabled `at` job with `context: light`. `when` is an ISO datetime (offset-less = default timezone), `in <n>m\|h\|d`, or `today\|tomorrow HH:MM`. Past times are rejected. |

Every failure returns `{ ok: false, error }` and never throws. Agent writes record revisions
with actor `agent` and the run id.

## HTTP API

| Route | Behaviour |
|---|---|
| `GET /api/jobs` | `JobDTO[]` ordered by slug |
| `POST /api/jobs` `{ slug, content }` | create, 201; 409 if the slug exists; 400 when invalid |
| `GET /api/jobs/:slug` | `{ job, nextFireTimes (5), runs (last 10: status, suppressed, durationMs, conversationId, assistantMessageId) }` |
| `PUT /api/jobs/:slug` `{ content, expectedHash }` | CAS save; 409 `{ current }`; 404; 400 |
| `DELETE /api/jobs/:slug` | delete (revisions stay) |
| `PUT /api/jobs/:slug/enabled` `{ enabled }` | rewrites the `enabled:` line |
| `POST /api/jobs/:slug/run` | `{ runId }` or `{ skipped }` |
| `GET /api/jobs/:slug/revisions` | newest first |
| `POST /api/jobs/:slug/revert` `{ revisionId }` | restores as a new revision |

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
- In the transcript a fired job shows as the wake divider followed by her reply. Only `state`
  frames stream live during a wake.

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

-- event dedupe rows
select j.slug, f.event_key, f.fired_at from agent_job_fires f join agent_jobs j on j.id = f.job_id
order by f.fired_at desc limit 20;
```

## Known limits

- **A cron/every job whose `active_hours` can never match** saves fine and never fires
  (`next_run_at = null`, "—" on the page). Follow-up: reject it at write time.
- **Interrupted runs leave `last_outcome` stale.** `recoverOrphans` marks runs `interrupted`
  outside `execute`, so `onRunFinished` never sees them and the streak does not move.
- **At-most-once across a crash.** An event's fire row and an `at` job's claim commit before the
  wake. A crash or a wake error in between loses that fire.
- **`runJobNow` can race the tick.** There is no row lock between the overlap check and the wake,
  so both can pass and produce two runs.
- **The cron density check** looks at a fixed 8-day window, so a day-of-month or month-restricted
  pattern that is dense only outside that window slips through.
- **Revisions have no FK.** Deleting a job leaves its revisions, and the 30-day `at` prune deletes
  them explicitly.
- **The `woken ·` divider shows `job` instead of the slug** for job wakes. `Conversation.vue`
  splits the origin `wake:job:<slug>` with `split(':', 2)`.
