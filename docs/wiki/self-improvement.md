---
title: Bridget self-improvement (reflector, gate, About Tony profile, job tuning, review tools)
status: built  # cycle 76, on feat/bridget-self-improvement; not merged, not deployed (migration 0063 dev only)
cycle: 76
updated: 2026-09-30
---

# Bridget self-improvement

Since cycle 76, Bridget learns from experience in a **separate, restricted pass**. A tool-less
**reflector** reads settled conversations and, every night, the engagement signals on her job
messages. It proposes three kinds of change:

- **skills**: a new procedure, or an edit to an existing one;
- the **About Tony profile**: a preference Tony stated;
- **jobs**: wording, schedule or active hours changed, or the job paused.

Plain code decides each proposal's route. It is applied automatically with provenance, queued on
`/review`, or dropped. Nothing the reflector writes is trusted until it has passed the gate.

Memory learning is separate and older (the enrichment loop, [memory.md](memory.md)). Reflection
never edits Bridget's **persona** (spec D7).

Spec: [2026-09-30-bridget-self-improvement-design.md](../superpowers/specs/2026-09-30-bridget-self-improvement-design.md).
Handover: [2026-09-30-bridget-self-improvement.md](../handovers/2026-09-30-bridget-self-improvement.md).

## The flow

```
settled thread (every 15 min)        nightly jobs pass (hourly tick, once/day from 03:00 local)
  messages since reflected_through     closeObservations → `ignored`; jobs with ≥ 5 signals / 14 d
            │                                   │  (file + counts + ≤ 5 snippets each)
            └──────────── reflector: ONE chat('reasoning') call, no tools ───────────┘
                                   │  JSON → zod → ≤ 3 proposals
                                   ▼
                     processProposal (reflect/apply.ts)
                  gate: mode → evidence → rejection memory → validity → tier
                        → sensitive → Jev (one-way) → caps → review_only
                                   │
            ┌──────────────────────┼─────────────────────────┐
          auto                  review                     dropped
   applyImprovement('agent')   review_queue row            agent_improvements row
   CAS on the hash read         kind 'self-improvement'     with drop_reason
   BEFORE the model call        → approve applies as
   → applied | conflict→review    actor 'human' (CAS again)
```

Every proposal gets an `agent_improvements` row, whatever happens to it, and publishes the
`agentImprovement` live event.

## Modules: `server/lib/agent/reflect/`

| File | Job |
|---|---|
| `candidates.ts` | `threadCandidates({ now?, limit? = 5, onlyConversationIds? })`, `markReflected` |
| `transcript.ts` | renders messages (tool calls summarised) as `[user]` / `[bridget]` / `[tool name → …]`, keeping the newest 24k chars |
| `prompt.ts` | `THREAD_SYSTEM_PROMPT`, `threadReflectionMessages`, `jobsReflectionMessages`, `skillFilesForPrompt` (each skill file ≤ 2 KB, 16 KB total) |
| `call.ts` | `callReflector(messages, allowedKinds)`: never throws; returns `ok:false` on a model failure |
| `schema.ts` | `Proposal`, `parseReflectorOutput`: tolerant parsing. It strips fences, tries successive `{`/`[` starts, repairs trailing commas outside strings and runs zod. A reply starting "None" means no proposals |
| `gate.ts` | the pure gate (below) |
| `jev.ts` | `jevCheck(p)`: observable questions, one-way |
| `similarity.ts` | `contentDelta`, `similarity` (Jaccard over word 3-shingles) |
| `apply.ts` | `processProposal`, `applyImprovement`, `rejectImprovement`, `countAutoAppliedToday` |
| `thread-pass.ts` | `runThreadPass({ now?, onlyConversationIds?, chatFn?, jev? })` |
| `jobs-pass.ts` | `runJobsPass({ now?, onlyJobSlugs?, chatFn?, jev? })` |

`onlyConversationIds` and `onlyJobSlugs` are the **test and acceptance seams**. The dev DB is
shared, so anything run by hand should always be scoped with them.

## Rhythms and timing

| Task | Cron (UTC) | Does work when |
|---|---|---|
| `reflect-threads` (`server/tasks/reflect-threads.ts`) | `*/15 * * * *` | mode ≠ `off`. Candidates need **≥ 4** new user/assistant rows since `reflected_through`, last activity **≥ 30 min** ago, not reflected in the last **2 h**, a last message within **7 days**, and at most **5** threads per tick. Main is included. |
| `reflect-jobs` (`server/tasks/reflect-jobs.ts`) | `40 * * * *` | mode ≠ `off`, **agent-timezone hour ≥ 3**, and `reflect_jobs_last_date` ≠ today. The setting is written only after a completed pass, so the pass normally lands at 03:40 local, and a missed tick runs later the same day. |

The spec said 03:30. Nitro cron is UTC-only and the agent timezone is a runtime setting, so the
nightly pass uses an hourly tick with a local-hour check (Ruling 2).

**Failures:** a failed or unparseable reflector reply marks the thread for **one retry** on the
next tick (in memory, per process). A second failure advances the watermark with no proposals,
so a thread never blocks. The watermark also advances on zero proposals.

⚠️ **A dev server on this branch reflects over the whole dev DB every 15 minutes** unless
`self_improvement_mode` is `off`. That includes real threads and main. It happened once during
the build: improvement `fc6947d5` came from real dev threads. For acceptance, set the mode to
`off` and call the pass through its seam with `--as-on` for just that call (see the handover).

## Signals (evidence for the jobs pass)

`server/lib/agent/signals/`. `classify.ts` is pure; `write.ts` does the DB writes. Existing code
paths write the signals, fire-and-forget, never the model.

- A job run's assistant message opens a **2 h observation window**. The window is derived from
  `created_at` (`openObservation` from `jobs/outcome.ts`).
- Tony's next message on main within the window gives `replied` (`noteUserReply`, hooked on every
  `trigger:'user'` enqueue in `runtime/queue.ts`). Its text can add `said_stop` and/or
  `said_thanks`:
  - stop words: stop, not useful, don't send, dont send, unsubscribe, too many;
  - thanks words: thanks, thank you, helpful, perfect, nice;
  - matching is whole-word, and a negation guard means "don't stop" and "non-stop" don't count.
- A tapback on the delivered iMessage gives `tapback_positive` (love, like, laugh, emphasize) or
  `tapback_negative` (dislike). A question tapback is ignored. This is `noteTapback` in
  `channels/inbound.ts`, with the same allowlist and direct-chat checks as tapback approvals. A
  tapback consumed as an approval isn't counted.
- A window that closed with nothing gives `ignored`. `closeObservations` runs at the start of the
  jobs pass. It only judges messages created after `signals_started_at` (a setting written on the
  first call) and within 14 days.
- One row per `(message_id, kind)` (unique index), inserted with ON CONFLICT DO NOTHING.

## The gate: `gate.ts` (pure), in order

1. **Mode.** `off` → dropped (`mode_off`).
2. **Evidence.** Every quote must be **≥ 12 chars** (else `evidence_too_short`) and a
   whitespace-normalised **verbatim substring** of the pass input (else `evidence`). There is no
   fuzzy matching. The input is the **transcript only** for the thread pass, and **that job's
   signal snippets only** for the jobs pass. It never includes the skills, profile or job file
   that were also in the prompt.
3. **Rejection memory.** It compares the proposal's **delta** (lines added or changed against the
   target at pass time) with the deltas of rejections of the same kind family and target within
   the last **30 days**. Similarity **≥ 0.8** → `rejected_recently`. `skill.create` and
   `skill.edit` form one family. A rejected `job.disable` is remembered by kind and target.
4. **Validity.** The existing skill and job parsers and validators apply, including cycle 74's
   active-hours check. A skill must be **≤ 4 KB**. The profile after the edit must be
   **≤ 1,500 tokens** (`ceil(chars/4)`). An edit of a skill whose full file the reflector wasn't
   shown → `invalid: body_not_shown`. An edit of a missing target → `target_missing`.
5. **Tier.** `auto` for a `skill.create` of a new slug, and for a `skill.edit` or `job.edit` of an
   **agent-authored** target. Everything else goes to `review` (reason `tier`): the profile,
   anything Tony wrote, and `job.disable`. A `skill.create` over an existing slug is tiered as an
   edit. A `job.edit` that changes `enabled` in either direction always goes to review
   (`changes_enabled`).
6. **Sensitive** skill content (`SENSITIVE`: exec*, shell, command(s), terminal, sudo, rm -rf,
   password, secret, token, api key, credential, delet*, drop table) → review.
7. **Jev** (one-way, `JEV_BUMP = 0.6`): any unwanted answer ≥ 0.6 → review. If Jev is
   unavailable, the proposal also goes to review (fail closed). Jev reads the proposal and its
   own evidence quotes, not the transcript. The raw answers are stored in
   `agent_improvements.jev`.

   | Kind | Questions (unwanted = high) |
   |---|---|
   | skill | `one_off`: fixes one situation rather than a reusable procedure? `time_bound`: tied to a date, event or temporary state? |
   | profile | `inferred`: inferred or guessed rather than stated? `passing`: a passing mood or one-off? |
   | job | `unrelated`: the evidence is about something other than Tony's reaction to this job? |
8. **Caps.** An `auto` proposal beyond **5 applied per day** (agent timezone; counted as auto
   improvements whose revision actor is `agent`), or on a target already changed in the last
   **24 h**, → review (`cap`).
9. **review_only** mode demotes whatever is still `auto`.

The mode is **re-read after the Jev call**, just before applying. Drops never call Jev.

## Apply: `apply.ts`

- The **CAS hash and diff base are read before the model call**. An edit Tony makes while the pass
  runs is therefore a conflict, never a silent revert.
- `applyImprovement(id, actor)` writes through the target's own store (`saveSkillSource`,
  `saveJob`/`setJobEnabled`, `saveProfileSource`) and tags the revision with **`improvement_id`**.
  Actor values stay `human | agent | system`. What the spec called `agent:reflection` is
  `actor: 'agent'` plus a non-null `improvement_id`.
- A skill's `source:` frontmatter is re-derived on apply: `agent` on a create, and the existing
  author on an edit. A proposal therefore can't relabel Tony's skill as agent-authored.
- **CAS conflict:** nothing is written. The row becomes `conflict`, with `expectedHash` and
  `currentContent` refreshed to the target's current state, and a review item is queued. Conflict
  is **not terminal**: it counts as pending.
- Any other apply failure during an auto apply → `dropped` (`apply_failed: …`). On approve it
  returns a **422** "Could not apply: …".
- **Reject** stores `delta` in the proposal for the 30-day memory.

## About Tony profile

- Table `agent_profile`: a single row, **created lazily** under `pg_advisory_xact_lock` (reads
  take the oldest row). Columns are `content`, `content_hash`, `updated_by`, `updated_at`.
  Revisions live in `agent_config_revisions` with `target_kind = 'profile'`.
- Service `server/services/profile.ts`: `getProfileSource`, `saveProfileSource` (CAS),
  `listProfileRevisions`, `revertProfile`.
- API: `GET /api/profile/source` (with tokens and budget), `PUT /api/profile/source`
  `{ content, expectedHash }` (409 `{ current }` on a stale hash), `GET /api/profile/revisions`,
  `POST /api/profile/revert` `{ revisionId }`.
- **Prompt:** `buildSystemPrompt` injects `## About Tony` right after the persona. The profile is
  clamped to 1,500 tokens with a `…(profile truncated)` marker. An empty profile is omitted, and
  a load failure is logged and never breaks a turn.
- **UI:** `/settings/profile` uses the shared `MarkdownConfigEditor`, `RevisionsPanel` and
  `useConfigSource` (kind `profile`). It has explicit Save (⌘S), a starter template on first
  load, and a token meter against 1,500, which warns when over. A revision the reflector wrote
  shows a **learned** badge.
- The profile **never auto-applies** (D2).

## Settings

- `self_improvement_mode`: `on` (default when absent), `review_only` or `off`. It is read fresh on
  every call. `GET/PUT /api/settings/self-improvement`; UI in **Settings → Bridget**
  ("Self-improvement" select).
- `reflect_jobs_last_date` is the nightly pass's once-a-day marker.
- `signals_started_at` is the cut-off for judging `ignored`.
- **Settings → Voice** (`/settings/voice`) is the old `/voice` studio, moved. `/voice` redirects
  there with a 301, and the main-nav entry is gone.

## `/review` and the review tools

- `self-improvement` cards (`app/components/review/SelfImprovementCard.vue`) show:
  - the kind, with the target linked (skill, job or `/settings/profile`);
  - confidence, reason, and a line diff against `currentContent`;
  - the evidence quotes, with a "View the source thread" link;
  - review-reason chips (`tier`, `sensitive`, `jev_*`, `cap`, …) and Jev answers;
  - Approve and Reject.
- **One registry of choices:** `shared/review/choices.ts` `reviewChoices(item)`. The page renders
  its buttons from it, and the tools list and validate against it.
  - Most kinds: `approve` / `reject`.
  - `memory-unreviewed`: `approve` "Mark reviewed" / `reject` "Discard".
  - Memory conflicts: `keep-both`, `archive-old`, `archive-new`, `archive-both`.
- **One decision service:** `server/services/review-decisions.ts` `decideReview(id, choice)`. The
  approve, reject and resolve routes are thin wrappers over it, so undo tokens, revisions,
  rejection memory and live events are identical whoever decides. A not-pending item, unknown
  kind or invalid choice returns `ok:false` with a plain reason and changes nothing. A 409 maps to
  `conflict` and a 422 to `apply_failed`.
- **`list_reviews({ kind?, limit? = 20 })`** is a read tool in `agentTools` (every run, and MCP).
  It returns pending items with `id`, `kind`, `summary`, `createdAt`, a kind-specific `detail`
  and `choices`.
- **`decide_review({ id, choice, note? })`**: the confirmation rule.
  - It is `dangerous: true` and **profile-only** (`server/lib/agent/profile.ts`): it is not in
    `agentTools`, so **MCP never sees it**.
  - Headless runs never get it (`classifyForHeadless` → exclude).
  - **Every call pauses for Tony's confirmation**: the inline card in the app, or a 👍 over
    iMessage. A channel with no approval UI auto-denies.
  - It is **never allowlistable**. The allowlist is opt-in per tool (`AgentTool.allowlistable`,
    true only for `exec`). `approvalFor` ignores saved patterns for other tools, `ws.ts` refuses
    to save an "always allow" for them, and the card hides the checkbox.
  - The card text is `<choice> — <item summary>`.
- **`list_improvements({ since? })`** is a read tool. It returns the day's `agent_improvements`
  (default since the start of today in the agent timezone) with links. `pendingReview` is a
  **live** count (`pending_review` and `conflict`), not scoped by `since`.
- **Digest seed job** `self-improvement-digest`: `cron 30 21 * * *`, `context: light`,
  `deliver: [auto]`, installed **disabled**. It uses `list_improvements` and replies `NO_REPLY`
  when there were none.

## Schema: migration 0063 (additive)

- `agent_profile`: as above.
- `agent_signals`:
  - columns: `id`, `job_id` (FK set null), `run_id` (FK set null), `message_id`, `delivery_id`,
    `kind`, `detail`, `created_at`;
  - unique `(message_id, kind)` where `message_id` is not null;
  - index `(job_id, created_at)`.
- `agent_improvements`:
  - columns: `id`, `pass` (`thread`/`jobs`), `source_conversation_id`, `source_run_ids uuid[]`,
    `kind`, `target`, `proposal` jsonb, `jev` jsonb, `route` (`auto`/`review`/`dropped`),
    `drop_reason`, `status` (`applied`/`pending_review`/`rejected`/`dropped`/`conflict`),
    `revision_id`, `review_item_id`, `created_at`, `decided_at`;
  - `proposal` holds the `StoredProposal`: the reflector's fields plus `expectedHash`,
    `currentContent`, `reasons` and, once rejected, `delta`;
  - indexes `(status, created_at)` and `(kind, target, created_at)`.
- `conversations.reflected_through` (timestamptz) is the per-thread watermark.
- `agent_config_revisions.improvement_id` (uuid) is the provenance. The UI's learned badge keys
  off it.
- Live resources: `agentProfile` (invalidates `['profile']`) and `agentImprovement` (invalidates
  `['review']` and `['agentImprovement']`).

## Eval

`pnpm reflect:eval` (`scripts/reflect-eval.ts`, data in `scripts/data/reflect-eval.jsonl`) makes
20 real reflector calls on hand-written transcripts, with no gate and no DB writes. Run it by
hand; it always exits 0. First run (2026-09-30):

- precision on "none" rows: **10/10**;
- kind-level hit rate: **10/10**;
- exact kind + slug: **5/10**. Every miss was a `skill.create` with a different free-form slug.

## Operational SQL

```sql
-- the mode (absent = on)
select value from settings where key = 'self_improvement_mode';
-- turn reflection off / back on
insert into settings(key, value, updated_at) values ('self_improvement_mode', '"off"', now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
delete from settings where key = 'self_improvement_mode';

-- today's proposals and what happened to them
select created_at, pass, kind, target, route, status, drop_reason, proposal->'reasons' reasons, jev->'answers' jev
from agent_improvements where created_at > now() - interval '1 day' order by created_at desc;

-- drop reasons over the last 30 days (is the reflector quoting badly?)
select drop_reason, count(*) from agent_improvements
where route = 'dropped' and created_at > now() - interval '30 days' group by 1 order by 2 desc;

-- what reflection changed, with the revision it wrote
select i.kind, i.target, r.target_kind, r.actor, r.created_at
from agent_improvements i join agent_config_revisions r on r.improvement_id = i.id order by r.created_at desc;

-- the thread watermarks
select id, title, last_message_at, reflected_through from conversations
where reflected_through is not null order by reflected_through desc limit 20;

-- a job's signals over 14 days
select s.kind, count(*) from agent_signals s join agent_jobs j on j.id = s.job_id
where j.slug = 'morning-brief' and s.created_at > now() - interval '14 days' group by 1;

-- the nightly markers
select key, value from settings where key in ('reflect_jobs_last_date', 'signals_started_at');

-- the profile and its revisions
select content_hash, updated_by, updated_at, length(content) from agent_profile;
select created_at, actor, improvement_id from agent_config_revisions where target_kind = 'profile' order by created_at desc;
```

## Known limits

- The reflector **merges two lessons into one profile edit** in real runs, despite the Task 11a
  prompt line "a procedure is a skill, a preference is a profile edit". A receipts procedure plus
  a formatting preference came back as one `profile.edit` twice. It is safe, because the profile
  always goes to review, but the skill path wasn't exercised by a real run. Re-check with
  `reflect:eval` after any prompt change.
- The retry-once marker is in memory. A restart grants another retry.
- The Jev thresholds are uncalibrated (spec §12). The raw answers are stored for calibration.
- Reflection over Claude Code sessions, and cross-thread pattern mining, are out of scope.
