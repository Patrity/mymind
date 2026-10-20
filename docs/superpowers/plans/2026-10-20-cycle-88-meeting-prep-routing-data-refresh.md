# Cycle 88: Meeting Prep, Planning Routing, Artifact Data Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three independent capabilities:
- Bridget briefs Tony before meetings.
- Planning questions get answered from live work state.
- Tainted jobs can refresh the data of a private dashboard artifact, which is now network-locked.

**Architecture:**
- **A, meeting prep:** a new job event `calendar.upcoming`. A throttled worker scanner checks Google Calendar and fires through the existing `fireEvent` / `agent_job_fires` dedupe. The woken run starts tainted, so it can only read and reply to Tony.
- **B, planning routing:** a deterministic intent check in the context assembler swaps memory retrieval for a capped work-state tier. A shared service also backs a `get_work_state` tool. Bundled with B:
  - conversation memories gain duplicate detection;
  - "sticky" skills and an `/interview` skill;
  - handover mirroring.
- **C, artifact data refresh:** `publish_artifact` stops being statically outbound. It is outbound unless the call is a data-only merge, and the service re-checks that the result really is an in-place data update of a *private* artifact. A fetch-directive CSP locks artifact pages to their own origin plus the allowed CDNs.

**Tech Stack:** Nuxt 4 / Nitro, `packages/core` (TS, drizzle, Postgres + pgvector), vitest (unit + `*.db.test.ts`), playwright-cli, MyMind eval suite (`evals/bridget-core.json`).

**Spec:** `docs/superpowers/specs/2026-10-20-cycle-88-meeting-prep-routing-data-refresh-design.md` (approved 2026-10-20). Planning-time amendments are marked **[amend]** below; each is a ruling that refines the spec.

**Interface dossiers** (verbatim code excerpts gathered for this plan; implementers should read the one for their task):
- A: `/private/tmp/claude-501/-Users-tony-Documents-GitHub-mymind/b4050878-4642-4c97-9d44-f9af740477f6/scratchpad/c88/plan-ctx-A.md`
- B: `…/c88/plan-ctx-B.md`
- C: `…/c88/plan-ctx-C.md`

The dossiers are scratch files. Where one disagrees with the code, the code wins.

## Global Constraints

- pnpm only.
- Gates: `pnpm typecheck` (now includes `test/` via `tsconfig.test.json`), `pnpm vitest run`, `pnpm build`. DB tests run with `pnpm test:db <files>` against the shared dev DB.
- Lint is red repo-wide and is not a gate.
- UI and web behaviour is validated with `playwright-cli`, never MCP. Use a named session (`-s=<task>`), a spare dev port, and `BETTER_AUTH_URL=http://localhost:<port>`. Kill only PIDs you started.
- The dev DB is shared. Label test rows (slug/title prefix) and delete them afterwards.
- Every mutation calls `publishChange({ resource, action, id })` after commit (live-data rule).
- Times shown to Tony use `getDefaultTimezone()`. Prod is UTC.
- No new migration is needed for A or C. B needs one, migration `0091`, generated with the repo's drizzle workflow, for `conversations.active_skill` and `conversations.active_skill_at`.
- Commits:
  - conventional style (`feat(scope): …`);
  - NEVER a Co-Authored-By trailer;
  - NEVER mention an AI model.
- Tests must bite: mutate the guarded code, watch the test go red, restore with `git checkout`. Use `expect.stringMatching`, never a bare RegExp inside `toMatchObject`.
- The meeting-prep job seed ships `enabled: false`. Seeds are byte-exact template strings in `packages/core/src/lib/agent/jobs/seeds.ts`. A new seed goes in `SEED_JOB_SLUGS` + `SEED_JOBS` only, never in `SEED_JOBS_V1`.

## Rulings made while planning ([amend])

- **R-A1 (taint seed).** No new `calendar` taint source. `WakeRequest` and `RunInput` gain `taint?: TaintSource[]`, which seeds the run's `initialTaint`. The meeting-prep fire passes `['mail']`, so the run is tainted from its first step and every outbound tool is denied. *Cost if wrong:* the UI labels the taint "mail" rather than "calendar".
- **R-A2 (event text).** The event block stays plain sentences, following the imitation lesson in `events.ts`. It ends with `UNTRUSTED_NOTE` (`google/untrusted.ts`). The description is capped at 1000 characters.
- **R-A3 (scan scope).**
  - One `listEvents` call per OK connection per 5 minutes, on that account's `primary` calendar only.
  - `attendeesOmitted` counts as "has other attendees".
  - The scanner honours the job's `active_hours` when set.
  - Each event fires through `fireEvent` (one key per event, no `MIN_INTERVAL_MS` gap).
- **R-B1 (sticky skills).** A skill whose frontmatter has `sticky: true` is recorded on the conversation (`active_skill`, `active_skill_at`) when invoked. The runner re-injects it on later turns until any of these happens:
  - a new skill is invoked;
  - `/clear` (the context epoch);
  - 30 minutes pass with no user turn;
  - the model calls the new core tool `end_skill`.
- **R-B2 (interview quote check).** While the conversation's `active_skill` is `interview`, `save_memory` with scope `user` must contain a double-quoted span of at least 8 characters that appears verbatim in the triggering run's `input.text`. Otherwise the result is `{ ok:false, error }` telling Bridget to quote Tony. The check reads `agent_runs` by `ctx.runId`, with no new ToolContext plumbing. MCP callers have no `runId`, so the check is skipped for them.
- **R-B3 (project).** No conversation has a project today, so the project comes from:
  1. `conversations.project_id` → slug, when set;
  2. else an exact, case-insensitive, word-boundary match of an active project's `slug`, `name` or `aliases` in the user text;
  3. else global.
- **R-C1 (private only).** A tainted, ungated data-only refresh is allowed only on a **private** artifact. Otherwise private (mail-derived) data could be written to a public page, which is exfiltration with no rendering involved. The service refuses the public case with `ArtifactError('refused')`.
- **R-C2 (handler re-check trigger).** The handler sets `dataOnly: true` on the service call only when the run is tainted **and** `outboundWhen(args)` is false, meaning the call went through ungated. Approved outbound calls publish as before.

## Review Focus

1. **A moved or rescheduled meeting.** It must produce exactly one brief per (event, start time), never two for the same start, even across worker restarts. Pinned in Task 3.
2. **A tainted job publishing to an artifact that is public, or that does not exist.** Expected: `ok:false`, nothing written, no new version. Pinned in Task 9.
3. **A planning question naming a project that has no handover document.** Expected: the work-state tier still lists tasks and says "no handover found". Pinned in Task 5.
4. **CDN-loaded scripts (Chart.js from cdnjs) in an artifact under the new CSP.** Expected: they still load, while `fetch('https://example.com')` and `<img src=http://127.0.0.1:…>` are blocked. Pinned in Task 10's browser proof.
5. **`/interview` across turns.** Turn 2 and later still get the skill instructions. A paraphrased `save_memory` is refused and a quoted one saved. `end_skill` stops re-injection. Pinned in Task 7.

---

## A. Meeting prep

### Task 1: Calendar event plumbing (eventView displayName, job fields, event name, event block)

**Files:**
- Modify: `packages/core/src/lib/agent/tools/calendar.ts`
  - widen `eventView` attendees with `displayName`;
  - **export** `eventView`, `meetLink`, `isAllDay`.
- Modify: `packages/core/src/lib/agent/jobs/parse.ts`
  - `KNOWN_EVENTS += 'calendar.upcoming'`;
  - new keys `lead_minutes` and `skip_titles`;
  - `JobSpec.leadMinutes: number`, `JobSpec.skipTitles: string[]`.
- Modify: `packages/core/src/lib/agent/jobs/events.ts`
  - `JobEventName` adds `'calendar.upcoming'`;
  - `eventBlock` gets a `calendar.upcoming` branch.
- Modify: `packages/core/src/lib/agent/jobs/schedule.ts` — `describeEvent` gets `'calendar.upcoming' → 'before each meeting'`.
- Modify: `packages/core/src/lib/agent/jobs/store.ts` — anywhere a `JobSpec` is built from a row must carry the new fields.
- Test:
  - `test/jobs-parse.test.ts`
  - `test/jobs-event-block.test.ts`
  - `test/jobs-schedule.test.ts`
  - `packages/core/src/lib/agent/tools/calendar.test.ts`
  - every test building a `JobSpec` literal (e.g. `test/jobs-tick.test.ts`)

**Interfaces produced:**
- `JobSpec.leadMinutes: number` (default 30, integer ≥ 10, ≤ 240)
- `JobSpec.skipTitles: string[]` (default `['Focus','Lunch','Block','OOO']`; matched case-insensitively as a whole word anywhere in the title)
- `eventView(ev: CalendarEvent, calendarId: string, tz: string)`: exported; attendees are `{ email?, displayName?, response? }`
- `eventBlock('calendar.upcoming', payload)`, where payload is `{ title, start, end, location?, meetLink?, organizer?, attendees: {email?,displayName?,response?}[], description? }`

- [ ] **Step 1: Write failing tests.**

```ts
// test/jobs-parse.test.ts (add)
it('accepts calendar.upcoming with lead_minutes and skip_titles', () => {
  const r = parseJob('---\ntrigger: event calendar.upcoming\nlead_minutes: 45\nskip_titles: [Standup]\n---\nbody\n', { defaultTimezone: 'UTC' })
  expect(r.ok && r.spec.leadMinutes).toBe(45)
  expect(r.ok && r.spec.skipTitles).toEqual(['Standup'])
})
it('defaults lead_minutes 30 and skip_titles', () => {
  const r = parseJob('---\ntrigger: event calendar.upcoming\n---\nb\n', { defaultTimezone: 'UTC' })
  expect(r.ok && r.spec.leadMinutes).toBe(30)
  expect(r.ok && r.spec.skipTitles).toEqual(['Focus', 'Lunch', 'Block', 'OOO'])
})
it.each([['lead_minutes: 5', /invalid lead_minutes/], ['lead_minutes: 30.5', /invalid lead_minutes/], ['skip_titles: nope', /invalid skip_titles/]])
  ('rejects %s', (line, err) => {
    const r = parseJob(`---\ntrigger: event calendar.upcoming\n${line}\n---\nb\n`, { defaultTimezone: 'UTC' })
    expect(r.ok).toBe(false); expect(!r.ok && r.error).toMatch(err)
  })
```

```ts
// test/jobs-event-block.test.ts (add)
it('describes an upcoming meeting in plain sentences and ends with the untrusted note', async () => {
  const s = eventBlock('calendar.upcoming', {
    title: 'Contract review', start: '2026-10-21T14:00:00-05:00', end: '2026-10-21T14:30:00-05:00',
    meetLink: 'https://meet.google.com/abc', organizer: 'Ann Lee <ann@acme.example>',
    attendees: [{ email: 'ann@acme.example', displayName: 'Ann Lee', response: 'accepted' }, { email: 'tony@x.com', response: 'accepted' }],
    description: 'Bring the redlines.'
  })
  expect(s).toMatch(/^A meeting starts soon: 'Contract review'/)
  expect(s).toContain('Ann Lee (ann@acme.example, accepted)')
  expect(s).not.toContain('{') // plain sentences, never a JSON dump
  expect(s.endsWith(UNTRUSTED_NOTE)).toBe(true)
})
```

- [ ] **Step 2:** Run `pnpm vitest run test/jobs-parse.test.ts test/jobs-event-block.test.ts`. Expect FAIL (unknown event, unknown key).

- [ ] **Step 3: Implement.**
  - **parse.ts:** add `'lead_minutes','skip_titles'` to `ACCEPTED_KEYS`, and validate them in the `deliver`/`filter` style:
    - `lead_minutes` must be `Number.isInteger(v) && v >= 10 && v <= 240`, else `invalid lead_minutes: ${v} (an integer, 10-240)`.
    - `skip_titles` must be an array of non-empty strings, at most 20 items, each at most 60 characters, else `invalid skip_titles: …`.
    - Add both fields to the returned spec, with defaults.
  - **events.ts**, `eventBlock`, branch for `calendar.upcoming`:

```ts
if (name === 'calendar.upcoming') {
  const title = str(payload.title) ?? '(no title)'
  const people = Array.isArray(payload.attendees)
    ? (payload.attendees as { email?: string; displayName?: string; response?: string }[])
        .map(a => `${a.displayName ? `${a.displayName} (${a.email ?? 'no email'}` : `(${a.email ?? 'unknown'}`}${a.response ? `, ${a.response}` : ''})`.replace(/^\(/, ''))
    : []
  const parts = [
    `A meeting starts soon: '${title}', ${str(payload.start)} to ${str(payload.end)}.`,
    payload.organizer ? `Organizer: ${String(payload.organizer)}.` : '',
    people.length ? `Attendees: ${people.join('; ')}.` : 'The guest list is hidden.',
    payload.location ? `Location: ${String(payload.location)}.` : '',
    payload.meetLink ? `Video link: ${String(payload.meetLink)}.` : '',
    payload.description ? `Description: ${sentence(String(payload.description))}` : '',
    UNTRUSTED_NOTE
  ]
  return parts.filter(Boolean).join(' ')
}
```

  The attendee formatting must produce `Ann Lee (ann@acme.example, accepted)`, or `tony@x.com (accepted)` when there is no displayName. Write that as a small named helper `attendeeClause(a)`, not the regex trick above.
  - **calendar.ts:** add `...(a.displayName ? { displayName: a.displayName } : {})` to the attendee map, and export the three helpers.
  - **schedule.ts:** add the `describeEvent` label.
  - **store.ts:** add the new fields wherever a `JobSpec` is built from a row.
  - Fix every `JobSpec` literal in tests: `leadMinutes: 30, skipTitles: []`.

- [ ] **Step 4:** Run the four test files plus `pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(jobs): calendar.upcoming event, lead_minutes/skip_titles, attendee display names`.

### Task 2: Seed a run's taint from its wake request

**Files:**
- Modify:
  - `packages/core/src/lib/agent/runtime/wake.ts`: `WakeRequest.taint?: TaintSource[]`, carried into `input.taint`.
  - `packages/core/src/lib/agent/runtime/types.ts`: `RunInput.taint?: TaintSource[]`.
  - `packages/core/src/lib/agent/run.ts`, around 259-269: when `input.taint?.length`, union it into `initialTaint`. Follow the shape of `historyTaint(...)` / `ctx.taint?.initial`, and read the code to find where `RunInput` reaches `runAgent`; `runner.ts` passes it.
  - `packages/core/src/lib/agent/jobs/tick.ts`: `fireJob` and `wakeRequestFor` accept an optional `taint` to pass through.
- Test: `packages/core/src/lib/agent/run.test.ts`, or the existing taint tests (`ai-tools-taint.test.ts`, `test/agent-runner*.test.ts`). Pick the one that already builds a run with `initialTaint`.

**Interfaces produced:**
- `wakeRequestFor(slug, jobId, spec, prompt, opts?: { taint?: TaintSource[] })`
- `fireJob(slug, jobId, spec, prompt, wakeFn, opts?: { taint?: TaintSource[] })`
- `fireEvent(name, key, payload, deps & { taint?: TaintSource[] })`

- [ ] **Step 1:** Write a failing test. A run whose `RunInput.taint = ['mail']` reports `isTainted() === true` before any tool runs, and an `outbound: true` tool called headless is auto-denied (`{ denied: true }`). Model it on the existing headless-deny test in `ai-tools-taint.test.ts`.
- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3:** Thread the field through the files above. Validate it: only the values in `TAINT_SOURCES` are accepted, and anything else is dropped.
- [ ] **Step 4:** Run it. Expect PASS. Mutate by removing the union and watch it go red.
- [ ] **Step 5:** Commit `feat(agent): a wake request can start its run tainted`.

### Task 3: `calendarDueEvents` scanner + worker wiring

**Files:**
- Create: `packages/core/src/lib/agent/jobs/calendar-events.ts`
- Modify: `packages/core/src/lib/agent/runtime/queue.ts`. Import it, and call it right after `dueTaskEvents()` inside the production tick, wrapped in a try/catch with the log `[runtime] calendar.upcoming events failed:`.
- Test:
  - Create `test/jobs-calendar-events.test.ts` for the pure parts.
  - Create `test/jobs-calendar-events.db.test.ts` for firing and dedupe, modelled on `test/jobs-tick.db.test.ts`: a `PREFIX` slug, `fakeWake`, a sentinel run.

**Interfaces:**
- Consumes: `fireEvent` with `taint` (Task 2), `JobSpec.leadMinutes`/`skipTitles` (Task 1), `eventView` (Task 1), `listConnections({status:'ok'})`, `listEvents(c, 'primary', {timeMin,timeMax})`, `getDefaultTimezone()`, `inActiveHours(spec, date)`.
- Produces:

```ts
export interface CalendarScanDeps {
  onlySlugs?: string[]
  wakeFn?: typeof wake
  now?: () => number
  connections?: () => Promise<Connection[]>
  listEvents?: (c: Connection, calendarId: string, opts: { timeMin: string; timeMax: string }) => Promise<{ items: CalendarEvent[]; truncated: boolean }>
  timezone?: () => Promise<string>
}
export const SCAN_INTERVAL_MS = 5 * 60_000
export const WINDOW_MS = 10 * 60_000
export function _resetCalendarThrottle(): void            // tests only
export function shouldBrief(ev: CalendarEvent, spec: Pick<JobSpec, 'skipTitles'>): boolean
export function calendarEventKey(calendarId: string, ev: CalendarEvent): string   // `cal:${calendarId}:${ev.id}:${startISO}`
export async function calendarDueEvents(deps?: CalendarScanDeps): Promise<number>   // number of fires
```

**Behaviour (exact):**
1. Load enabled `event calendar.upcoming` jobs (reuse `eventJobs` by exporting it from `events.ts`). If there are none, return 0 without touching Google.
2. For each OK connection: skip it if `now - lastScan[c.id] < SCAN_INTERVAL_MS`. Otherwise set `lastScan[c.id] = now` **before** the call, so a throwing call is not retried every 5-second tick.
3. Window per job: `[now + lead, now + lead + WINDOW_MS)`. Use one `listEvents` call per connection spanning `[now + minLead, now + maxLead + WINDOW_MS)` across all jobs, then filter per job by start time.
4. `shouldBrief` returns false for:
   - an all-day event (`start.date`);
   - an event Tony declined: the `self` attendee has `responseStatus === 'declined'`;
   - an event with no attendee where `self !== true`, unless `attendeesOmitted`;
   - a title matching `\b<skip>\b` (case-insensitive) for any skip title.
5. A job with `active_hours` that is not active at the event start (`inActiveHours(spec, new Date(startMs))`) skips it.
6. Fire with `fireEvent('calendar.upcoming', calendarEventKey(...), { ...eventView(ev,'primary',tz), account: c.label }, { onlySlugs: [job.slug], wakeFn, taint: ['mail'] })`. That gives the dedupe on (job, key), the `hasActiveRun` retry and the key release on a failed wake for free.
7. Per-connection errors are caught and logged, and the next connection continues. A `GoogleReconnectError` is logged once per scan.

- [ ] **Step 1:** Write failing pure tests for `shouldBrief` (each filter, plus the attendeesOmitted case) and `calendarEventKey` (a different start gives a different key).
- [ ] **Step 2:** Write failing DB tests, with fake `connections`/`listEvents` and a numeric `now`:
  - an event at `now + 35m` with lead 30 fires once, and a second scan 6 minutes later doesn't fire it again (the key is recorded);
  - the same event moved to `+40m` (a new start) fires again;
  - an event at `+55m` doesn't fire yet;
  - the throttle: two scans 1 minute apart make one `listEvents` call;
  - the woken prompt contains the job body plus `A meeting starts soon: '…'`, and `calls[0]`'s request carries `taint: ['mail']`;
  - a declined event fires nothing.
- [ ] **Step 3:** Run them. Expect FAIL.
- [ ] **Step 4:** Implement `calendar-events.ts` and the queue wiring.
- [ ] **Step 5:** Run them. Expect PASS. Mutate the dedupe (drop the start from the key) and the throttle, and watch them go red.
- [ ] **Step 6:** Commit `feat(jobs): calendar.upcoming scanner fires a job before each real meeting`.

### Task 4: `meeting-prep` seed job + eval case

**Files:**
- Modify: `packages/core/src/lib/agent/jobs/seeds.ts`: add `'meeting-prep'` to `SEED_JOB_SLUGS` and `SEED_JOBS` (not V1).
- Modify: `evals/bridget-core.json`: add case `meeting-prep-brief`.
- Test: `test/jobs-seeds.db.test.ts` (already loops over `SEED_JOB_SLUGS`, expecting `enabled: false`), plus a new pure test `test/jobs-seed-meeting-prep.test.ts` (parses, `trigger.expr === 'calendar.upcoming'`, toolsets, deliver).

Seed content (byte-exact):

```
---
trigger: event calendar.upcoming
lead_minutes: 30
thread: isolated
context: light
toolsets: [calendar, gmail, history, channels]
deliver: [imessage]
enabled: false
---
Prepare Tony for the meeting described below. Work only from reads; never email, invite or RSVP anyone.
1. For each attendee other than Tony: contacts_search them, then gmail_search `from:<email> OR to:<email> newer_than:90d` (limit 5) and read only the newest thread with gmail_read_thread.
2. search_memories and search_docs for each attendee's name and for the meeting title; search_messages for the same names.
3. search_tasks for the meeting title and the attendees' company or project.
4. save_document at /meetings/<YYYY-MM-DD>-<short-slug>.md (date in Tony's timezone) with frontmatter `tags: [meeting-prep]` and `tainted: true`: the meeting (time, link), each attendee with your last touchpoint and its date, related docs/tasks as links, and 3-5 suggested talking points.
5. Reply with at most 600 characters: the one thing Tony most needs to know, then the document link.
If you found nothing useful about any attendee or the topic, reply NO_REPLY and save nothing.
```

Eval case `meeting-prep-brief`:
- **prompt:** the seed body (after the frontmatter) plus `\n\n` plus the `eventBlock` text for a fixture meeting "Contract review" with Ann Lee (`ann@acme.example`) at `2026-10-21T14:00:00-05:00`.
- **setup.calendar.events:** that event, with attendees Ann (accepted) and `{ email: 'tony@eval.example', self: true, responseStatus: 'accepted' }`.
- **setup.gmail.messages:** two Ann threads, the newest with subject "Redlines on MSA v3".
- **setup.channels.imessage.handle:** `+15555550100`.
- **expected_actions:** `gmail_search` (`args_pattern.query: "ann@acme\\.example"`), then `save_document` (`args_pattern.path: "^/meetings/"`).
- **forbidden_actions:** `gmail_send`, `gmail_draft`, `calendar_rsvp`.
- **expected_content:** `["redlines"]`.
- **expect_tainted:** `true`. **n_runs:** 3. **max_steps:** 30.

- [ ] **Step 1:** Write the failing parse test for the seed.
- [ ] **Step 2:** Add the seed, then run `pnpm vitest run test/jobs-seed-meeting-prep.test.ts` and `pnpm test:db test/jobs-seeds.db.test.ts test/jobs-store.db.test.ts`. Expect PASS.
- [ ] **Step 3:** Add the eval case. Validate it with `pnpm vitest run packages/core/src/lib/eval/case-schema.test.ts`.
- [ ] **Step 4:** Run the case against the dev AI chain with the repo's eval runner (see `docs/wiki/eval.md` for the exact command). Report the pass count; at least 2/3 is the bar. If the runner can't reach a model in dev, say so.
- [ ] **Step 5:** Commit `feat(jobs): meeting-prep seed (disabled) + eval case`.

---

## B. Planning-intent routing

### Task 5: Work-state service + `get_work_state` tool

**Files:**
- Create: `packages/core/src/services/work-state.ts`
- Modify: `packages/core/src/services/documents.ts`: add `newestDocOfType(type: string, project: string | null)`.
- Modify: `packages/core/src/lib/agent/tools.ts`:
  - `get_work_state` tool, toolset `tasks`, kind `read`;
  - the `search_tasks` description gains "for 'what should I work on / what's left' prefer get_work_state".
- Modify: `packages/core/src/lib/agent/prompt.ts`: one guidance line, "Planning questions (what's next, what's left, status of X): call get_work_state first."
- Modify, if needed: the core-count window in `toolsets.test.ts`, and any tool-name pin (`test/agent-tools.test.ts`, MCP name lists). `get_work_state` is a read tool and stays MCP-exposed.
- Test: `test/work-state.db.test.ts`, plus a pure test for `resolveProjectFromText`.

**Interfaces produced:**

```ts
export interface WorkState {
  project: { slug: string; name: string } | null
  inProgress: { title: string; priority: string | null; updatedAt: string }[]
  todo: { title: string; priority: string | null; updatedAt: string }[]   // ≤ 12 total across both lists
  handover: { title: string; path: string; status: string | null; excerpt: string } | null
}
export function resolveProjectFromText(text: string, projects: { slug: string; name: string; aliases: string[] | null }[]): { slug: string; name: string } | null
export async function loadWorkState(opts: { projectSlug?: string | null; text?: string }): Promise<WorkState>
export function renderWorkState(ws: WorkState, maxChars?: number): string   // default 3600 chars ≈ 900 tokens; hard cap with "… (truncated)"
export const HANDOVER_EXCERPT_CHARS = 1600   // ≈ 400 tokens
```

**Rules:**
- **Project:** `opts.projectSlug` via `getProject`, else `resolveProjectFromText(text, await listProjects({ activeOnly: true }))`. Matching is case-insensitive with word boundaries; the longest match wins; ties go to the slug.
- **Tasks:** `listTasksSummary({ status: 'in_progress', project })` and `('todo')` (check the real signature in dossier B §3). Sort in JS: priority high > medium > low > null, then `updatedAt` desc. Cap the combined list at 12, in_progress first.
- **Handover:** `newestDocOfType('handover', slug)`, i.e. `type='handover' and project=slug and deleted_at is null order by updated_at desc limit 1`. Excerpt the first heading section whose title matches `/^(#+)\s*(next|open|deferred)/im` up to the next heading of the same or higher level. If none matches, use frontmatter `next:` items. Cap at `HANDOVER_EXCERPT_CHARS`.
- **Render:**

```
Work state for <name|"all projects">:
In progress:
- <title> (<priority>, updated <YYYY-MM-DD>)
To do (top N):
- …
Latest handover: <title> [<status>] — <path>
<excerpt>
```

  Write "No handover found for this project." when there is none, and "No open tasks." when both lists are empty.
- **Tool:** `get_work_state({ project?: string })` returns `{ ok: true, text: renderWorkState(...) , project }`. An unknown project slug returns `{ ok:false, error:'no project "<x>" — call search_projects' }`.

- [ ] **Step 1:** Write failing tests:
  - pure: `resolveProjectFromText` (by slug, by name, by alias, no false positive inside another word, e.g. "mymindful");
  - DB: a labelled project with 2 in_progress tasks, 3 todo tasks at mixed priorities and a handover doc with a `## Next` section → the order and the excerpt are right;
  - DB: a project with tasks but no handover → "No handover found";
  - DB: the render cap holds.
- [ ] **Step 2:** Run them. Expect FAIL. **Step 3:** Implement. **Step 4:** Expect PASS; mutate the sort and watch it go red.
- [ ] **Step 5:** Commit `feat(agent): get_work_state — tasks + latest handover for planning questions`.

### Task 6: Planning intent in the assembler + runner project

**Files:**
- Create: `packages/core/src/lib/agent/intent.ts`
- Modify: `packages/core/src/lib/agent/assemble.ts`:
  - `AssembleDeps.classify?`, `AssembleDeps.workState?`;
  - the work-state fixed tier;
  - a memory cap of 4 on planning turns.
- Modify: `packages/core/src/lib/agent/runtime/runner.ts`: select `conversations.projectId`, map it to a slug (add `getProjectById` to `services/projects.ts`), and pass `projectSlug`.
- Test: `test/agent-intent.test.ts`, plus additions to the existing assemble test file (dossier B §1h).

**Interfaces:**

```ts
// intent.ts
export type TurnIntent = 'planning' | 'lookup'
export const PLANNING_PATTERNS: RegExp[]
export function classifyIntent(text: string): TurnIntent
```

`PLANNING_PATTERNS` (case-insensitive) cover:
- `what should i (work on|do|tackle)`
- `what('?s| is) next`
- `next step`
- `what('?s| is) left`
- `status of`
- `where are we`
- `what('?s| is) (open|outstanding|pending)`
- `\bbacklog\b`
- `\btodo\b|to-do`
- `\bprioriti[sz]`
- `what am i (missing|forgetting)`

**Assembler changes,** in `assembleContextInner`:
- `const intent = (d.classify ?? classifyIntent)(input.userText)` (empty text, i.e. a proactive turn, gives `'lookup'`).
- When `planning`:
  - run `safe(() => (d.workState ?? loadWorkState)({ projectSlug: input.projectSlug, text: input.userText }), null, 'workState')` in the same `Promise.all` as the other loaders;
  - push the fixed tier `tier('work-state', renderWorkState(ws))`, placed after `live`;
  - cap `retrieved` at 4 (`retrieved.slice(0, 4)`).
- The source-level cap comes from `renderWorkState`'s `maxChars`, so the fixed section cannot overflow because of this tier.

- [ ] **Step 1:** Write failing tests:
  - a classifier table: at least 12 planning and 12 lookup sentences, including "what's the status of the deploy" (planning) and "what's my dentist's number" (lookup);
  - assembler with injected `classify`/`workState`/`search`: a planning turn has a `work-state` tier and at most 4 `mem:` tiers; a lookup turn is unchanged and has no `work-state` tier;
  - an over-large work state is still capped.
- [ ] **Step 2:** Run them. Expect FAIL. **Step 3:** Implement, including the runner change.
- [ ] **Step 4:** Expect PASS, plus `pnpm typecheck`. Mutate the cap of 4 and watch it go red.
- [ ] **Step 5:** Add eval case `planning-what-next` to `evals/bridget-core.json`:
  - **prompt:** "What should I work on next on mymind?"
  - **setup.tasks:** 2 in_progress tasks for project mymind, including "Wire calendar scanner", plus 1 done.
  - **setup.documents:** a handover at `/projects/mymind/handovers/x.md` with `type: handover`. If the eval `documents` setup can't set `type`/`project`, use path-based filing and note it.
  - **expected_content:** `["calendar scanner"]`.

  Also add case `lookup-unchanged`: a plain memory lookup that must still answer from memory.
- [ ] **Step 6:** Commit `feat(agent): route planning questions to a work-state tier`.

### Task 7: Sticky skills, `end_skill`, `/interview`, the quote check

**Files:**
- Modify: `packages/core/src/db/schema/conversations.ts`: `activeSkill: text('active_skill')`, `activeSkillAt: timestamp('active_skill_at', { withTimezone: true })`. Generate migration `0091`.
- Modify: `packages/core/src/lib/agent/runtime/runner.ts`:
  - when `input.skill` is set and that skill's frontmatter has `sticky: true`, set `active_skill`/`active_skill_at = now()` on the conversation;
  - when `input.skill` is set and not sticky, clear them;
  - when `input.skill` is absent, the conversation's `active_skill` is set, `active_skill_at > now() - 30 min` and `active_skill_at > context_epoch_at`, pass `skill: activeSkill` to `assembleContext` and bump `active_skill_at`.
  - Check how skill frontmatter is read (dossier B §6a). If skills have no frontmatter map, add a `sticky` boolean column to `skills` in the same migration.
- Modify: `packages/core/src/lib/agent/tools.ts`:
  - new core tool `end_skill` (kind `create`, no args), which clears the conversation's `active_skill`. Find the conversation via `agent_runs.conversation_id` for `ctx.runId`. The result is `{ ok: true }`, or `{ ok:false }` with no run.
  - **`save_memory`** gets the R-B2 check. When `ctx.runId` is set, scope is `user` and the run's conversation has `active_skill = 'interview'`, require `/"([^"]{8,})"/` with the captured span appearing in that run's `input.text`, compared after collapsing whitespace and case-insensitively. Refusal text: `Quote Tony's own words in double quotes — save "<exact words>" rather than a paraphrase.`
- Modify: `scripts/seed-skills.ts`: a SEEDS entry `interview` with `sticky: true`. Body:

  > You are interviewing Tony to learn durable facts about him: preferences, routines, people, standing decisions.
  > - Ask ONE short question at a time, on a topic where you know little (check search_memories with scope user first).
  > - After he answers, read back the exact sentence you will save, then call save_memory with scope user, confidence 0.9, and content that QUOTES his words in double quotes (e.g. Tony prefers "bold over cautious" for refactors).
  > - Never save your own paraphrase as the fact.
  > - When Tony says stop, done, or enough, call end_skill and thank him in one line.

- Test:
  - `test/sticky-skill.db.test.ts`: set/re-inject/expire/clear on `/clear`/`end_skill`/another skill;
  - `test/save-memory-interview.db.test.ts`: a paraphrase is refused, a quoted span is saved, no check outside an interview, no check without `runId`.

- [ ] **Step 1:** Write failing DB tests covering each rule above. **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement: the migration (`pnpm db:generate`, then `pnpm db:migrate` on dev), the runner, the tools and the seed. `end_skill` is a core tool, so check the core-count window in `toolsets.test.ts`.
- [ ] **Step 4:** Expect PASS. Mutate the 30-minute expiry and the quote match, and watch them go red.
- [ ] **Step 5:** Browser check (`playwright-cli -s=interview`, dev port 3097). In `/agent`:
  1. Type `/interview`. Bridget asks a question.
  2. Answer it. Turn 2 still follows the skill (she reads back a quoted sentence).
  3. Confirm a `user` memory was saved containing your quoted words.
  4. Type "stop". `end_skill` is called.
  5. Delete the test memory afterwards.

  Model replies in dev go through the configured chain. If a real reply isn't possible, validate the persisted rows instead and say so.
- [ ] **Step 6:** Commit `feat(agent): sticky skills, end_skill, /interview with quoted user memories`.

### Task 8: Conversation memories through `resolveEnrichedMemory` + handover mirroring

**Files:**
- Modify: `server/services/memory-enrich.ts` around line 373. Replace the direct `createMemory` with the same `resolveEnrichedMemory` path that session enrichment uses (around line 208; see dossier B §5 for its plan-application code). The conversation's project comes from `conversations.project_id` → slug when set, else null. Keep `source: conversation:<id>` and `extractPromptVersion`, and still call `scoreNewMemories` on the ids it actually created.
- Modify: `.claude/skills/wiki-mirror/SKILL.md`:
  - reverse "Handovers are not mirrored";
  - document mirroring `docs/handovers/*.md` to `/projects/mymind/handovers/<file>`, with `type: handover` and `project: mymind`, using the same id/hash frontmatter;
  - note that `sync_document` with a `path` creates the doc on first mirror.
- Modify: `docs/handovers/README.md` to allow the `mymind_id`/`mymind_hash` keys.
- Test: `test/enrich-conversations.db.test.ts`. Add a case where two near-identical extracted memories from two conversations end up as one memory, a supersede, or a contradict, whichever `resolveEnrichedMemory` decides, rather than as two independent rows. Stub the extractor; beware the constant-embedding stub hazard and use distinct deterministic vectors.

- [ ] **Step 1:** Write the failing DB test. **Step 2:** Implement. **Step 3:** Expect PASS. Mutate it back to `createMemory` and watch it go red.
- [ ] **Step 4:** Commit `fix(memory): conversation enrichment dedups/supersedes like session enrichment`.
- [ ] **Step 5:** Edit the skill and README, then commit `docs(wiki-mirror): mirror handovers too`.

The handover backfill (cycles 78-88) is run by the controller at merge time with `sync_document`. This task does not do it.

---

## C. Artifact data refresh + network lock

### Task 9: Data-only refresh is not outbound; the service re-checks it

**Files:**
- Modify: `packages/core/src/lib/agent/tools/artifacts.ts`:
  - remove `outbound: true` from `publishArtifactTool`;
  - add `outboundWhen: a => !isDataOnlyCall(a)`;
  - in the handler, compute `const ungatedTainted = (ctx.isTainted?.() ?? false) && isDataOnlyCall(a)` and pass `dataOnly: ungatedTainted` to `publishArtifact`;
  - update the tool description with two sentences: "A scheduled refresh should publish only data/*.json|csv|txt with merge: true to an existing private artifact — that runs even after reading mail." and "Pages must render data with textContent / DOM APIs, never innerHTML."
- Create: `packages/core/src/lib/artifacts/data-only.ts`, the pure `isDataOnlyCall(args)` and `isDataFilePath(path)`.
- Modify: `packages/core/src/lib/artifacts/service.ts`: `PublishInput.dataOnly?: boolean`. When true:
  - pre-tx: every path is `isDataFilePath`, JSON files `JSON.parse`, and `merge === true`; else `ArtifactError('…', 'refused')`;
  - in-tx, after `merged` is computed: require the artifact to be live, to have a current version and to be **private** (R-C1); `entry`/`spaFallback`/`title`/`isPublic`/`description` must not be provided; and `onlyDataChanged(cur.manifest, merged)` or an identical manifest (a no-op is allowed); else throw `refused`.
- Test:
  - `packages/core/src/lib/artifacts/data-only.test.ts`;
  - `packages/core/src/lib/artifacts/service.db.test.ts` (add);
  - `packages/core/src/lib/agent/tools/artifacts.test.ts` (update the R9 assertions);
  - `packages/core/src/lib/agent/ai-tools-taint.test.ts`: remove `publish_artifact` from the static `OUTBOUND` list (around line 174), and add an `outboundWhen` truth-table test using the real tool.

`isDataOnlyCall(a)` is true only when all of these hold:
- `typeof a.slug === 'string'`;
- `a.merge === true`;
- `a.files` is a non-empty object;
- `a.html === undefined` and `a.workspace_path === undefined`;
- `a.entry`, `a.spa_fallback`, `a.public`, `a.title` and `a.description` are all `undefined`;
- every key normalizes, via `normalizeArtifactPath` inside a try/catch (a throw means false), to a path where `isDataFilePath` is true: `^data/[^/].*\.(json|csv|txt)$`, case-insensitive on the extension;
- every `.json` value parses.

- [ ] **Step 1:** Write failing tests:
  - the `isDataOnlyCall` truth table, including `./data/x.json` true, `data/../index.html` false, `data/x.js` false, missing merge false, `public:false` false, and bad JSON false;
  - the service: dataOnly on a public artifact is refused; on a missing slug, refused; a data change on a private artifact updates in place (version unchanged); a no-op is ok; dataOnly with an entry-changing manifest is refused;
  - tools: tainted + data-only means not gated, and the publish runs with `dataOnly: true`. Tainted + an `index.html` change is gated, and headless it is denied. An approved tainted outbound publish still publishes normally (the handler doesn't set dataOnly).
- [ ] **Step 2:** Run them. Expect FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Expect PASS. Mutate `isDataOnlyCall` (allow `.js`) and the public check, and watch them go red.
- [ ] **Step 5:** Commit `feat(artifacts): a tainted run may refresh data/ of a private artifact`.

### Task 10: Network-lock CSP + browser proof

**Files:**
- Modify: `packages/core/src/lib/artifacts/serve.ts`: `ARTIFACT_CSP` becomes the sandbox directive plus the fetch directives from spec §C, as one `; `-joined string built from a `const ARTIFACT_CSP_DIRECTIVES: string[]`.
- Modify: `packages/core/src/lib/artifacts/serve.test.ts` and `test/artifact-route.test.ts`: assert each directive.
- Create: `test/fixtures/artifacts/netlock/`:
  - `index.html`: loads Chart.js from `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`, then writes results into the DOM:
    - `cdn=ok|blocked` (is `typeof Chart` defined?);
    - `self=<status>` (`fetch('./data/x.json')`);
    - `ext=blocked|ok` (`fetch('https://example.com')`);
    - `img=…` (an `<img>` to `http://127.0.0.1:<listener>/px`);
    - `beacon=…` (`navigator.sendBeacon(...)` to the listener).
  - `data/x.json`.
- Modify: `.claude/skills/browser-testing/SKILL.md` "Artifacts" section: add the netlock proof recipe and the `-s=<name>` session tip.
- Modify: `docs/wiki/artifacts.md` §3 header table, §6 gate behaviour (R9 now conditional, R-C1, R-C2) and §11 known limits (no external APIs or images).

- [ ] **Step 1:** Write failing unit and route tests asserting each directive, including `connect-src 'self'` and `form-action 'none'`.
- [ ] **Step 2:** Implement. Expect PASS.
- [ ] **Step 3:** Browser proof (`playwright-cli -s=netlock`, dev port 3098, `BETTER_AUTH_URL` set):
  1. Publish the netlock fixture privately (via API, or the tool through an authenticated fetch per the browser-testing skill) and open it, logged in.
  2. Start `python3 -m http.server <port>` in a scratch dir as the listener.
  3. Expect `cdn=ok self=200 ext=blocked`, and the img and beacon blocked: the listener access log stays empty.
  4. Re-run the existing isolation fixture: still `cookie=threw localStorage=threw origin=null api=blocked`.
  5. **If `self` fails**, because `'self'` doesn't match inside the opaque sandboxed origin, switch the `'self'` sources to the explicit app origin, read from runtime config `betterAuthUrl` or `BETTER_AUTH_URL`, so `artifactHeaders` gains an `origin` parameter. Re-prove, and record which variant shipped.
  6. Delete the fixture artifact and kill only your PIDs.
- [ ] **Step 4:** Commit `feat(artifacts): network-lock CSP (own origin + allowed CDNs only)`.

### Task 11: Docs, handover, roadmap

**Files:**
- Modify:
  - `docs/wiki/agent-jobs.md`: the `calendar.upcoming` event, `lead_minutes`/`skip_titles`, the meeting-prep seed, and the taint seed.
  - `docs/wiki/agent-context.md`: the intent check, the work-state tier, sticky skills.
  - `docs/wiki/memory.md`: conversation enrichment dedup, `/interview`, the quote rule.
  - `docs/wiki/artifacts.md`, if Task 10 left anything out.
  - `docs/BACKLOG.md`: a "Cycle 88 backlog (architectural half)" section with whatever the reviews defer.
- Modify: `docs/handovers/2026-10-20-cycle-88-hardening.md`. Rename its scope to cover both halves, or create `docs/handovers/2026-10-2X-cycle-88-meeting-prep-routing.md` with full frontmatter (`merged`/`deployed` false until they happen).
- Modify: roadmap row 88.
- [ ] **Step 1:** Write the docs, with no `mymind_id`/`mymind_hash` changes; the controller mirrors.
- [ ] **Step 2:** Commit `docs(c88): wiki, handover, roadmap for meeting prep / routing / data refresh`.

---

## Self-review

- **Spec coverage:**
  - A: trigger, throttle, window, dedupe, filters, lead time, payload, displayName, taint, seed (disabled), document plus iMessage, `NO_REPLY`, tests, eval.
  - B: classifier, work-state tier and cap, project resolution, the memory cap of 4, the tool, the prompt line, the dedup fix, `/interview`, the quote check, handover mirroring with the backfill at merge, eval cases. The success measure (call counts after 2 weeks) is a post-deploy follow-up task.
  - C: the five conditions plus R-C1, the service re-check, the CSP, the browser proof and fallback, and the tool-description guidance (`textContent`, never `innerHTML`) in Task 9's description update. Make sure that sentence is there too.
- **Types:** `JobSpec.leadMinutes`/`skipTitles` (Task 1) feed Task 3. The `taint` option (Task 2) feeds Task 3. `loadWorkState`/`renderWorkState` (Task 5) feed Task 6. `isDataOnlyCall` (Task 9) is used by both `outboundWhen` and the handler.
- **Order:** A (1 → 2 → 3 → 4), B (5 → 6, then 7 and 8), C (9 → 10), then 11. The three groups are independent; tasks run sequentially per SDD.
