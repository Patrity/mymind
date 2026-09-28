---
title: "Bridget jobs — markdown-configured schedules and triggers that make her talk on her own, plus Skills and Jobs as first-class pages (cycle 74)"
cycle: 74
date: 2026-09-28
status: spec
supersedes: null
builds_on: 2026-09-27-bridget-runtime-design.md
---

# Bridget jobs (cycle 74)

Cycle 73 shipped the runtime: turns are server-owned `agent_runs`, and `wake()` is the one
entry point for background runs (headless tool gate, `NO_REPLY` suppression). But nothing calls
`wake()` except a manual `/wake`, so Bridget's main thread sits empty. Tony's ask: **"her talking
there on her own"** — morning brief, evening wrap, Claude Code session digests, reminders and
errands she schedules herself, and heartbeat check-ins — with every one of those being a **job
configured in simple markdown**, editable on demand by Tony or by Bridget, the way OpenClaw
(`HEARTBEAT.md`, cron jobs) and Hermes (natural-language cron) do it.

Cycle 75 then adds channels (two-way BlueBubbles/iMessage first). This cycle stores and parses the
`deliver` field but only implements in-app delivery.

## 1. Decisions (brainstorm, 2026-09-27/28)

| # | Decision | Rejected |
|---|---|---|
| D1 | All five behaviours ship, each as a **job**, not a hard-coded path. | picking a subset |
| D2 | **Bridget may edit any job freely**, including Tony's, in interactive AND background runs. Every change is a revision with revert. Two rate guards remain (not permissions): 5-min minimum interval, 50 enabled jobs. | tiered; propose-only |
| D3 | **Heartbeat always wakes the model** each tick (OpenClaw-style); silence via `NO_REPLY`. Cost controls: active hours, local default model, light context. | change-first precheck; hybrid |
| D4 | **A silent run leaves nothing in the thread** — only its `agent_runs` row (visible in the Runs drawer). The event divider is written only when she speaks. (Changes cycle 73, which kept the divider on suppression.) | collapsed marker; keep dividers |
| D5 | Schedules live in **Postgres**, fired by the cycle-73 worker tick with `croner` for next-fire computation. **No pg-boss**: it would duplicate `agent_runs` (two queues, two retry policies) and not own the editable config. | pg-boss; in-memory timers; external scheduler |
| D6 | A job is **markdown with YAML frontmatter** (settings) and a body (the prompt). The markdown is the single source of truth; derived state is recomputed on save. Edited as raw markdown — no form layer. | form fields + markdown body |
| D7 | Skills and jobs move to **dedicated tables** (`agent_skills`, `agent_jobs`), out of `documents`. Living agent config must not mix with project docs. | reserved `/_agent/` namespace in `documents` |
| D8 | **Skills** and **Jobs** become main-nav pages with dedicated routes (`/skills/[slug]`, `/jobs/[slug]`) reusing the documents page's editor/preview components; "Agent Skills" leaves Settings. | modals; keeping skills in Settings |
| D9 | One cycle, planned in two phases (config storage + UI; scheduler + triggers). | 74a/74b split |

## 2. Data model — migration 0056 (additive + one data move)

### 2.1 `agent_skills`

`id uuid pk`, `slug text unique`, `content text` (full markdown incl. frontmatter), parsed
`name`, `description`, `when_to_use` (for the prompt's tier-1 index), `active bool default true`,
`source text` (`human`|`agent`), `content_hash text` (CAS), `created_at`, `updated_at`.

### 2.2 `agent_jobs`

`id uuid pk`, `slug text unique`, `content text`, `source text`, `content_hash text`,
`created_at`, `updated_at`.
**Derived on every save** (never edited directly): `enabled bool`, `trigger_kind text`
(`cron`|`every`|`at`|`event`), `trigger_expr text`, `timezone text`, `next_run_at timestamptz`,
`parse_error text`.
**Runtime:** `last_run_at timestamptz`, `last_run_id uuid`, `last_outcome text`
(`spoke`|`silent`|`failed`|`skipped`), `consecutive_failures int default 0`.
Index: partial on `(next_run_at) where enabled and parse_error is null`.

### 2.3 `agent_config_revisions`

`id`, `target_kind text` (`skill`|`job`), `target_id uuid`, `content text`, `actor text`
(`human`|`agent`|`system`), `run_id uuid null`, `created_at`. Keep the last 100 per target
(pruned on write).

### 2.4 `agent_job_fires`

`(job_id, event_key)` primary key, `fired_at`. Dedupes event triggers (a given due task or ended
session fires a given job once).

### 2.5 `agent_runs.job_id`

Nullable fk to `agent_jobs` (`on delete set null`).

### 2.6 Skills data move

In 0056: `insert into agent_skills (slug, content, source, active, …) select … from documents
where type = 'skill' and deleted_at is null` (slug from the path's basename), then soft-delete
those documents. A boot backfill parses `name/description/when_to_use` for rows where they are
null. `getSkill`/`listSkills`/the prompt's skills index read `agent_skills`. The kill switch
(`agent_skills_enabled` setting) is unchanged.

## 3. The job file

```markdown
---
trigger: cron 30 7 * * 1-5     # cron <expr> | every <n>m|<n>h | at <ISO datetime> | event <name>
timezone: America/New_York     # IANA; default = settings `agent_timezone`, else server TZ
active_hours: 07:00-23:00      # optional; ticks outside → outcome 'skipped'
model: default                 # or a registry model id
thread: main                   # main | isolated
context: light                 # light | full
deliver: [app]                 # stored; only 'app' is honoured until cycle 75
enabled: true
filter: { project: mymind }    # event jobs only; optional key/value match on the event payload
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
```

**Validation** (on every save, human or agent): known keys only; trigger parses; timezone is a
valid IANA zone; `active_hours` is `HH:MM-HH:MM`; `model` resolves (or `default`); body is
non-empty and ≤ 20,000 chars. Failure → `parse_error` set, `next_run_at` null (never fires).

**Guards:** `every` ≥ 5m; a `cron` whose next two fire times are < 5 min apart is rejected; at most
50 enabled jobs (the 51st save with `enabled: true` is rejected with a clear error).

**Enabled switch in the UI** rewrites the `enabled:` line in the markdown (one source of truth).

## 4. Scheduler — `server/lib/agent/jobs/`

| Unit | Responsibility |
|---|---|
| `parse.ts` | Frontmatter → `JobSpec` or `{ error }`. Pure. |
| `schedule.ts` | `nextRunAt(spec, from)` via `croner` (timezone-aware, DST-safe); `nextFireTimes(spec, n)` for the UI; `describe(spec)` → plain English ("weekdays at 7:30"). Pure. |
| `store.ts` | Create/update/delete with CAS on `content_hash`; derive columns; write revision; `publishChange('agentJob')`. The only writer of `agent_jobs`. |
| `tick.ts` | Called from the cycle-73 worker tick: claim due jobs (`next_run_at <= now()`, `for update skip locked`), apply active hours / overlap check, advance `next_run_at`, call `wake()`. Also runs the `task.due` event query. |
| `events.ts` | `fireEvent(name, key, payload)` — finds enabled event jobs whose `filter` matches, dedupes via `agent_job_fires`, calls `wake()` per job. |
| `outcome.ts` | Hook from `finishRun`: write `last_outcome`, `consecutive_failures`; auto-disable after 3 consecutive failures. |

**Firing a job:** `wake({ reason: 'job:<slug>', prompt: body (+ event block), sessionKey: thread === 'main' ? 'main' : 'isolated:<slug>', model, jobId, context })`.

**Rules:**
- **Missed runs** (server down): a job past due fires **once**, then reschedules from now. No bursts.
- **No self-overlap:** if the job's previous run is still `queued`/`running`, outcome `skipped`,
  schedule advances.
- **`at` jobs** write `enabled: false` back (system revision) after firing; pruned 30 days later.
- **Events in 74:** `cc.session_end` (fired from `server/api/hooks/cc/[event].post.ts` on
  `SessionEnd`, payload: session id, title, project slug, duration, summary if present; key =
  session id) and `task.due` (tick query: tasks whose `due_date` has passed and are not completed;
  key = task id + due date).
- **Event block** appended to the prompt: a plain-sentence description of the event and its
  payload (no bracketed markers — the imitation lesson).

## 5. Runtime changes (cycle-73 code)

- `wake()` accepts `jobId` and `context`; `agent_runs.job_id` is set.
- **Silent runs leave nothing (D4):** the runner writes the wake event row **only** when the reply
  is not suppressed; a suppressed run persists no rows at all. Tool effects and proposals are real
  regardless (the wake prompt already tells her to mention what she queued, so a run that proposed
  something should not be silent).
- **Light context:** history is the last 4 turns after the summary tier (summary + recent-threads
  tiers still apply). `full` = today's behaviour.
- **Queued visibility (cycle-73 follow-up):** when `enqueue` queues a user message behind a
  running headless run, the server replies `{ type: 'queued', text }` and the client paints an
  optimistic user bubble (reusing the `steered` reconciliation path).
- **Legacy removal:** `server/lib/voice/ws-legacy.ts`, `server/lib/agent/runtime/flag.ts`, the
  `agent_runtime` setting reads, and the flag branches in `ws.ts`, `queue.ts`, `wake.ts`, the plugin
  and `summarize-threads` are deleted. Rollback from here is a code revert to a cycle-73 build.

## 6. Tools (in-app registry and MCP)

- **Skills:** `use_skill`, `create_skill`, `edit_skill`, `delete_skill` keep their names and
  schemas but read/write `agent_skills` (with revisions, actor `agent`).
- **Jobs (new):** `list_jobs`, `get_job` (content + status + next 5 fire times), `create_job`,
  `edit_job` (`old_string`/`new_string` find-replace like `edit_document`, or `content` full
  replace), `delete_job`, `run_job` (fires now, respecting overlap), `schedule_wake({ when, prompt,
  thread? })` → creates a one-shot `at` job (slug `reminder-<short id>`).
- **Headless gate classes** (cycle-73 table, extended):
  - Jobs tools run directly in background runs (D2): `list_jobs`, `get_job` → read;
    `create_job`, `edit_job`, `delete_job`, `run_job`, `schedule_wake` → run.
  - Skill writes stay `propose` in background runs (cycle-73 ruling).
  - The exhaustive gate-table test is updated for every new tool.
- **Rate guards (§3)** apply to agent and human writes alike and are enforced in `store.ts`, so no
  prompt-injected loop can exceed them.

## 7. UI

- **Main nav:** add **Skills** and **Jobs**. Remove "Agent Skills" from Settings; its enabled kill
  switch moves to the `/skills` header.
- **`MarkdownConfigEditor`:** extracted from the documents page's editor. It is source-agnostic
  (value + save(content, expectedHash) + conflict handling) and has a raw editor with frontmatter
  highlighting, a rendered preview toggle and live updates. `/documents` is refactored onto it, so
  there is one editor, not a fork.
- **`/skills`:** cards (name, description, source badge, active switch, updated). **`/skills/[slug]`:**
  editor + revisions (diff, revert).
- **`/jobs`:** table columns:
  - slug;
  - trigger in plain English;
  - next run (relative + absolute);
  - last outcome + time;
  - enabled switch;
  - invalid rows flagged.

  "New job" offers templates (brief, heartbeat, event digest, blank).
- **`/jobs/[slug]`:** editor + side panel:
  - next 5 fire times in the job's timezone;
  - validation status with the exact parse error;
  - last 10 runs (outcome, duration, link to the message or "silent");
  - **Run now**;
  - revisions (diff, revert);
  - enabled switch.
- **Live updates:** `publishChange` resources `agentSkill`, `agentJob` (both added to `ResourceName`
  and the live dispatcher).

## 8. Seed jobs (installed disabled)

`morning-brief` (cron weekdays 7:30), `evening-wrap` (cron daily 21:00), `heartbeat` (every 30m,
active hours 08:00-22:00, light context, checklist body), `session-digest` (event
`cc.session_end`). Tony enables them from `/jobs`. Seeds are written with actor `system` and
skipped if the slug exists.

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| invalid file | no schedule; error on the page; one note in main per content version ("job X is invalid: …") |
| run fails | `last_outcome = failed`, schedule continues, `consecutive_failures++` |
| 3 consecutive failures | auto-disable (system revision writes `enabled: false`) + note in main |
| missed while down | fires once on the first tick, then reschedules |
| CAS conflict on save | 409 with current content; UI shows the conflict like the documents editor |
| rate guard hit | save rejected with the reason; agent tool returns it as an error |
| DST / timezone | `croner`; tests on spring-forward and fall-back boundaries |

## 10. Testing

**DB tests:**
- due-job claim is exactly-once under concurrency (scoped to test job ids);
- missed-run catch-up fires once;
- `at` job self-disables with a revision;
- event dedupe via `agent_job_fires`;
- rate guards;
- skills data move (copy + soft-delete, fixture rows only);
- revision write, prune and revert;
- 3-failure auto-disable;
- `agent_runs.job_id` → outcome linkage;
- a silent wake persists zero conversation rows.

**Unit tests:**
- parser (every trigger form and each invalid form);
- `nextRunAt` / `nextFireTimes` incl. DST;
- `describe()`;
- light-context slicing;
- the gate table with the new tools.

Every new test is mutation-checked.

**Browser (`playwright-cli`):**
1. Create a heartbeat at `every 5m` on `/jobs`; the next fire times render; Run now → she posts in
   main, or stays silent and only the Runs drawer shows it.
2. Break the frontmatter → inline error; the job doesn't fire.
3. In chat: "remind me in 10 minutes to stretch" → an `at` job appears on `/jobs`, fires, the
   reply lands in main, and the job is disabled afterwards.
4. With `session-digest` enabled, end a Claude Code session → a digest lands in main.
5. `/skills/<slug>`: edit, preview and revert work; the Settings entry is gone; the nav shows
   Skills and Jobs.
6. Send a message while a heartbeat run is in progress on main → the bubble shows immediately
   ("queued") and is answered after.

## 11. Risks

- **Moving skills out of `documents`** touches every skill reader: prompt index, `use_skill`,
  slash-command skill tier (cycle 71), MCP. The plan must grep all `type = 'skill'` / `skillPath`
  uses.
- **Always-wake heartbeat cost.** Mitigated by active hours, the local default model and light
  context. `/jobs` shows per-job run counts so drift is visible.
- **Free job edits in background runs (D2)** mean a prompt-injected run can reschedule or create
  jobs. The guards cap the blast radius. Revisions make every change visible and reversible.
- **Refactoring `/documents` onto the shared editor** risks regressions in the most-used page. It
  needs browser validation of the documents editor too, not only the new pages.

## 12. Out of scope

- Channels and two-way BlueBubbles (cycle 75; `deliver` is parsed and stored only).
- Self-improvement: review fork, skill curator (cycle 76).
- A cron-builder UI (raw frontmatter + next-fire preview is the interface).
- Per-job cost budgets (visible run counts only).
