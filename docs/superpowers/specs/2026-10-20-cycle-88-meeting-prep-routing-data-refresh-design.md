---
title: "Cycle 88: meeting prep, planning-intent memory routing, tainted data refresh for artifacts"
cycle: 88
date: 2026-10-20
status: proposed
---

# Cycle 88: meeting prep, planning-intent routing, tainted data refresh

Three independent workstreams, bundled into one cycle because Tony prefers bundling. Each section stands alone.
Decisions already made by Tony (2026-10-20): data-only refresh plus a network lock; assembler routing plus tools
plus an interview skill; meeting prep is the first proactive behaviour.

## A. Meeting prep

**Goal.** About 30 minutes before a real meeting, Tony gets an iMessage with a short brief, plus a saved document
holding the full version. The brief covers who is attending, what he last discussed with them, related docs and
tasks, and open threads.

**Trigger: a new job event, `calendar.upcoming`** (option (b) from the map; no polling-job hacks).
- A `calendarDueEvents()` scanner runs in `workerTick` beside `dueTaskEvents()`. It is active only when an enabled
  job declares `trigger: event calendar.upcoming`.
- It is throttled to one Google `listEvents` call per 5 minutes per connected calendar account. The window is
  `[now + lead, now + lead + 10 min)`, which tolerates tick jitter and a missed tick.
- Dedupe goes through `agent_job_fires` with key `cal:<calendarId>:<eventId>:<startISO>`, the same as `task.due`.
  A moved meeting gets a new start time, so it gets a new brief.
- **Filters**, applied in code so no model is involved:
  - skip all-day events;
  - skip events Tony declined (`self.responseStatus === 'declined'`);
  - skip events with no attendee other than Tony;
  - skip events whose title matches a skip list (default `Focus`, `Lunch`, `Block`, `OOO`; editable in the job
    body's frontmatter).
- `lead` is the job's `lead_minutes`, default 30, minimum 10.

**Run.** The fire wakes the job with a structured event payload: title, start/end in `getDefaultTimezone()`,
location/meet link, organizer, and attendees `{email, displayName, response}`.
- `eventView` is widened to carry `displayName`.
- The description is capped at 1000 characters.
- The payload is inserted as **untrusted data** under the mail guard. The run starts tainted (source `calendar`),
  which is honest because event text is third-party.
- The seeded `meeting-prep` job body tells Bridget to do the following, using only reads plus Tony-only delivery,
  all of which are allowed in a tainted headless run:
  - per attendee, run `contacts_search`, then `gmail_search` `from:/to:` over the last 90 days (at most 5 threads,
    snippets only, with `gmail_read_thread` for the newest one);
  - `search_memories` and `search_docs` on the attendee names and the meeting title, and `search_messages` /
    `search_sessions` on the same;
  - `search_tasks` on the meeting title and the attendees' org/project;
  - write the brief with `save_document` to `/meetings/<YYYY-MM-DD>-<slug>.md`, tagged `meeting-prep`, holding
    the event, attendees, the last touchpoints with dates, related docs/tasks as links, and suggested talking points;
  - reply with a summary of at most 600 characters plus the document link, delivered with `deliver: [imessage]`.
- If the run finds nothing useful, it replies `NO_REPLY`: no message, no document.
- Job toolsets: `calendar`, `gmail`, `history`, `channels`.

**Safety.**
- `send_message` and `deliver` go to Tony's own handle only (no address parameter exists).
- No outbound tool is reachable in a tainted headless run (R9 already auto-denies them).
- The document lives in Tony's own store. The known residual (a tainted run's writes later flow into untainted
  runs) is unchanged and already listed in the google-connections backlog.
- The brief document gets frontmatter `tainted: true`, so a future fix for that residual can find these documents.

**Ships** as a seeded job that is **disabled** by default. It is enabled on prod after acceptance: a real meeting
on Tony's calendar produces exactly one brief.

**Tests.**
- Scanner unit tests with a fake clock and a fake calendar: the window edges, the dedupe across ticks, a moved
  event giving a re-fire, and each filter.
- The throttle.
- `eventView` displayName.
- An eval case in `evals/bridget-core.json`: given a fixture event and fixture mail, the brief names the last
  thread with the attendee, and the doc is saved.

## B. Planning-intent memory routing

**Problem (measured in the cycle-72 audit).** Open questions such as "what should I work on next on mymind" get
memories that are topically related but answer nothing. The store is close to write-only: 1,389 enrichment runs
against 4 searches.

**Change.**
1. **Deterministic intent check** in `assembleContextInner`, before the search, injectable through
   `AssembleDeps.classify`:
   - `planning` when the text matches a planning pattern set ("what should I work on", "what's next", "next step",
     "what's left", "status of", "where are we", "what's open", "backlog", "todo", "priorit…");
   - else `lookup`.
   - No LLM, because the assembly budget is 1.5 s.
2. **Work-state tier**, when the intent is `planning`. A new capped fixed tier `work-state` (at most 900 tokens,
   source-level cap so it can never blank the other fixed tiers) built from:
   - the project, resolved from `input.projectSlug` (new: `runner.ts` passes the run's project when known), else a
     project name or slug mentioned in the text (exact match against `search_projects`), else global;
   - `in_progress` tasks, then `todo` sorted by priority and recency (at most 12, title + priority + updated date);
   - the newest document of type `handover` for the project: title, frontmatter `status`, and its "Next" /
     "Open" / "Deferred" section, excerpted to 400 tokens.
   - Memory retrieval still runs but is capped at 4 hits for planning turns, so known preferences still surface.
3. **Tool `get_work_state({project?})`** (core `tasks` toolset, read) returns the same content, so the model can
   route itself when the classifier misses. The `search_tasks` description and one line in the prompt point
   planning questions at it.
4. **Bridget memory dedup fix.** `enrichConversations` (server/services/memory-enrich.ts:373) goes through
   `resolveEnrichedMemory` like session enrichment does, so Bridget-derived memories get
   dedup/supersede/contradict handling and a project.
5. **Interview skill** (seeded DB skill `interview`, invoked as `/interview`).
   - Bridget asks one question at a time about preferences, routines, people and standing decisions, choosing
     topics where the `user` layer is thin (a scope count per topic tag).
   - She saves each answer as a `user`-scope memory **quoting Tony's words verbatim**, with confidence 0.9, after
     reading it back.
   - She never records her own paraphrase as the fact, and stops when Tony says so.
   - Rule enforced in the skill text and by a check in `save_memory`: when called from the interview skill, the
     content must contain a quoted span from the last user turn.
6. **Handover mirroring.** The `wiki-mirror` skill is extended to cover `docs/handovers/*.md` (type `handover`),
   so the work-state tier has fresh handovers. A one-off backfill mirrors the handovers from cycles 78 to 88.

**Tests.**
- Classifier table tests.
- The assembler with `classify` injected: the planning turn gets the work-state tier and at most 4 memories; the
  lookup turn is unchanged.
- The overflow cap.
- `get_work_state` against the DB.
- A conversation-enrichment dedup DB test.
- Eval cases: "what should I work on next on mymind?" must cite an in-progress task title, and a lookup question
  is unchanged.
- Success measure after 2 weeks on prod: `search_memories` and `get_work_state` calls per week, compared with the
  4-per-month baseline.

## C. Tainted data refresh for artifacts, and a network lock

**Rule change to R9.** In a tainted run, `publish_artifact` is **not outbound** when all of the following hold:
1. the target artifact exists and is live;
2. `merge: true`;
3. every file path is under `data/` and is `.json`, `.csv` or `.txt`, and JSON files parse;
4. the call does not change `entry`, `spa_fallback`, `public`, `slug` or `title`;
5. the result is an in-place data update (`onlyDataChanged`).

Anything else stays outbound, as before. This is implemented as `outboundWhen` on `publish_artifact`, replacing
`outbound: true`, and the decision is re-checked inside the service at publish time. If the model's arguments
claim data-only but the result would not be data-only, the tainted publish is refused with `ok:false`.

**Why it is safe.** The page code was published either untainted or with Tony's approval. A data refresh cannot
change the code. The remaining risk is code that renders data unsafely (`innerHTML`), letting injected data run
markup. The network lock below removes the request-based channels for that.

**Network lock.** `ARTIFACT_CSP` gains fetch directives, in addition to the existing `sandbox`:
```
default-src 'self' data: blob:;
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com;
style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
```
- Must be verified in a real browser: that `'self'` matches the artifact's own URL inside a sandboxed (opaque
  origin) document, so `fetch('./data/x.json')` still works. If it does not, use the explicit origin from
  `BETTER_AUTH_URL` instead of `'self'`.
- Accepted cost (Tony chose this): pages cannot call external APIs, embed external images, or post forms.
- Accepted residual: an injected inline handler could still navigate the frame itself (`location=`), which CSP
  cannot block. This needs page code that renders data as HTML. The tool description and the artifact skill
  section tell Bridget to render data with `textContent` and DOM APIs, never `innerHTML`.

**Tests.**
- `outboundWhen` truth table (every condition, plus a tainted-run gate test).
- The service re-check (a model lying that a call is data-only).
- The CSP string.
- Browser, with playwright-cli:
  - an artifact fetching `./data/x.json` works;
  - an external `fetch`, an `<img>` to a local listener, and `navigator.sendBeacon` are blocked (the listener log
    stays empty);
  - a CDN `<script>` (Chart.js from cdnjs) loads;
  - the existing isolation fixture still passes.
- A tainted headless job refreshing `data/` succeeds; the same job changing `index.html` is denied.

## Out of scope
Morning brief, email to triage cards (later cycles reuse the A scanner pattern and the C data path). An LLM intent
classifier. Per-artifact network allowlists.
