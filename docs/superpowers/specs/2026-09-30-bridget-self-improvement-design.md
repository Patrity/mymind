---
title: "Bridget self-improvement — a reflector that turns experience into skills, a profile of Tony, and tuned jobs (cycle 76)"
cycle: 76
date: 2026-09-30
status: spec
supersedes: null
builds_on: 2026-09-28-bridget-channels-design.md
---

# Bridget self-improvement (cycle 76)

Cycles 73–75 made Bridget always-on: a server-owned runtime (73), jobs that make her speak on her
own (74), and iMessage/email channels (75), plus a reliability pass (0059–0062). The last piece of
the "Hermes / OpenClaw" shape is **learning from experience in a separate, restricted pass**.

Memory learning already exists: since cycle 70 the enrichment loop distills memories from Bridget
conversations. This cycle adds the three things she cannot learn today:

- **A. Doing things better** — solved procedures and Tony's corrections become new or improved
  skills.
- **B. Knowing Tony better** — preferences he states or shows land in an "About Tony" profile that
  is part of every prompt.
- **C. Tuning her own proactive behaviour** — jobs whose output Tony ignores, dismisses or engages
  with get their wording/schedule adjusted or are paused.

## 1. Decisions (brainstorm, 2026-09-30)

| # | Decision | Rejected |
|---|---|---|
| D1 | All three targets (skills, profile, jobs) in one cycle, sharing one reflection engine. | A/B now, C later |
| D2 | **Tiered autonomy.** Auto-apply (revision + undo): new skills and edits to skills Bridget authored. `/review` approval: profile changes, edits to anything Tony authored, disabling a job. A nightly digest lists everything. | all-automatic; all-review |
| D3 | **Two rhythms.** Per-thread reflection when a thread settles (idle ~30 min, enough new activity; main included); nightly reflection for jobs (needs a day of engagement signals). | nightly only; after every run |
| D4 | **A dedicated structured reflector** (a model call with no tools) that outputs proposals; plain code gates and applies them. | Bridget reflecting as herself via a restricted wake; hybrid |
| D5 | **Jev as an independent, one-way check**: observable questions per proposal; a risky read demotes auto-apply → `/review`; it never promotes. Raw answers stored for later calibration. | Jev deciding; no second opinion |
| D6 | The profile lives in **Settings → Profile** on the shared markdown editor (same components as `/skills/[slug]` and `/jobs/[slug]`); the voice studio moves from `/voice` to **Settings → Voice**. | a main-nav Profile page |
| D7 | Reflection edits Tony's **profile**, never Bridget's **persona** (the persona is Tony's definition of her). | reflection editing persona notes |

## 2. Data model — migration 0063 (additive)

### 2.1 `agent_profile`
Single-row config like a skill: `id`, `content` (markdown), `content_hash`, `updated_at`,
`updated_by` (`human` | `agent:reflection`). Revisions reuse `agent_config_revisions` with
`target_kind = 'profile'` (the table's `target_kind` gains the value; no new table).

### 2.2 `agent_signals`
One row per engagement observation on a proactive message:
`id`, `job_id` (FK set null), `run_id` (FK set null), `message_id` (the assistant row),
`delivery_id` (nullable), `kind` (`replied` | `tapback_positive` | `tapback_negative` |
`said_stop` | `said_thanks` | `ignored`), `detail` (short text), `created_at`.

### 2.3 `agent_improvements`
Every proposal the reflector makes, whatever happened to it:
`id`, `pass` (`thread` | `jobs`), `source_conversation_id`, `source_run_ids` (uuid[]),
`kind` (`skill.create` | `skill.edit` | `profile.edit` | `job.edit` | `job.disable`),
`target` (skill slug / job slug / `profile`), `proposal` (jsonb: new content or edit, reason,
confidence, evidence quotes), `jev` (jsonb raw answers, nullable), `route` (`auto` | `review` |
`dropped`), `drop_reason` (nullable), `status` (`applied` | `pending_review` | `rejected` |
`dropped` | `conflict`), `revision_id` (nullable), `review_item_id` (nullable), `created_at`,
`decided_at`.

### 2.4 `conversations.reflected_through`
timestamptz, nullable — the per-thread watermark (like `summarized_through`).

### 2.5 Settings
`self_improvement_mode`: `on` | `review_only` | `off` (default `on`).

## 3. Signals (evidence for jobs)

Written by existing code paths, never by the model:
- A job run's assistant message in main (or its iMessage delivery) opens an **observation window**
  of 2 hours.
- Tony's next user message in main or inbound iMessage within the window → `replied`; if its text
  matches a small stop/thanks lexicon ("stop", "not useful", "don't send", "thanks", "helpful") →
  `said_stop` / `said_thanks` additionally.
- A tapback on the delivered iMessage (cycle 75 inbound tapback routing) → `tapback_positive`
  (love/like/laugh/emphasize) or `tapback_negative` (dislike).
- Window closes with nothing → `ignored` (written by the nightly pass for closed windows).
Pure classification function + DB writes in the existing hooks; one signal row per kind per
message.

## 4. The reflector — `server/lib/agent/reflect/`

### 4.1 Per-thread pass
- **Trigger**: the enrichment-style idle check (`conversations` with ≥ 4 new messages since
  `reflected_through`, last activity ≥ 30 min ago, not reflected in the last 2 h), run from a
  Nitro task every 15 min; includes main.
- **Input**: the new messages (with tool-call summaries, corrections, outcomes), the list of
  existing skills (name + description + whether Bridget authored it), the current profile, and the
  titles of the last 30 days' rejected proposals for this conversation's targets.
- **Output** (zod-validated JSON): up to 3 proposals, kinds `skill.create`, `skill.edit`,
  `profile.edit`; each `{ target, content | edit, reason, confidence 0–1, evidence: string[] }`.
  An empty list is the expected common answer.
- Advances `reflected_through` after a successful pass (even with zero proposals).

### 4.2 Nightly jobs pass
- An internal Nitro task at 03:30 in the agent timezone — deliberately not a user-editable job, so
  reflection can't be edited into tuning itself.
- **Input**: each enabled job's content + the last 14 days of its signals (counts by kind + up to 5
  detail snippets).
- **Output**: up to 3 proposals, kinds `job.edit` (wording/schedule/active_hours) and
  `job.disable`.
- A job with fewer than **5 signals** in the window is skipped.

### 4.3 Model
The `reasoning` chain; a single call per pass; failures retry once on the next tick, then the
thread is marked reflected with no proposals (never blocks forever).

## 5. The gate — plain code, in order

1. **Mode**: `off` → nothing runs; `review_only` → every surviving proposal routes to `/review`.
2. **Evidence**: every evidence quote must appear verbatim (whitespace-normalised) in the pass
   input; any miss → `dropped` (`evidence`).
3. **Rejection memory**: same `kind` + `target` rejected in the last 30 days with a similar
   proposal (normalised content similarity ≥ 0.8) → `dropped` (`rejected_recently`).
4. **Validity**: content must parse (skills/jobs via their existing parsers, with the job
   validations from cycle 74/reliability); skill size ≤ 4 KB; profile after edit ≤ 1,500 tokens
   (estimated); invalid → `dropped` (`invalid`).
5. **Tier**:
   - `skill.create`, `skill.edit` of an agent-authored skill (last revision actor is an agent) →
     `auto`;
   - `profile.edit`, any edit to a Tony-authored skill or job, `job.disable` → `review`;
   - `job.edit` of a job Tony authored → `review`; of an agent-authored job → `auto`.
6. **Sensitive content**: a skill mentioning exec/shell/commands, credentials/secrets/tokens, or
   deletion → `review`.
7. **Jev** (one-way): observable questions per kind —
   - skill: "Is this a reusable procedure rather than a one-off fix?" (yes wanted),
     "Is this tied to a single point in time?" (no wanted);
   - profile: "Did Tony state this directly (not inferred)?", "Is this a passing mood or one-off
     situation?";
   - job: "Does the evidence describe Tony's response to this job's messages?".
   Any unwanted answer with probability ≥ 0.6 → `auto` becomes `review`. Jev unavailable → `review`.
8. **Caps**: `auto` beyond 5 per day (agent timezone) or a second change to the same target in
   24 h → `review`.

## 6. Apply

- `auto` → the existing store functions with actor `agent:reflection` and provenance
  (`improvement_id`, source conversation):
  - skills: `saveSkillSource` / skill create;
  - jobs: `saveJob` (CAS on the content hash read at pass time — a mismatch → `conflict` → `/review`);
  - profile never auto-applies (D2).
- `review` → a `/review` item of a new type `self-improvement` (see §7); approve applies via the
  same functions (CAS again; conflict → shown as stale with "re-propose" disabled), reject records
  `rejected` for the 30-day memory.
- Every outcome writes/updates the `agent_improvements` row and publishes a live event.

## 7. UI

- **Settings → Profile** (`/settings/profile`): the shared `MarkdownConfigEditor` (cookie
  `mm.config.viewMode`), `RevisionsPanel` with `:dirty`, explicit Save (⌘S), editor gated on
  `loaded` — the same components and composable (`useConfigSource`, kind `profile`) as
  `/skills/[slug]` and `/jobs/[slug]`. A starter template on first load. A token meter against the
  1,500 cap.
- **Settings → Voice** (`/settings/voice`): the existing `/voice` page moved unchanged; `/voice`
  redirects; main-nav entry removed.
- **Settings → Bridget**: a "Self-improvement" select (`on` / `review only` / `off`).
- **`/review`**: `self-improvement` cards — kind, target, diff (line diff like RevisionsPanel),
  reason, confidence, evidence quotes (linked to the source thread), Jev answers; Approve / Reject.
- **Skills / Jobs revisions**: revisions with actor `agent:reflection` show a "learned" badge and a
  link to the source thread.
- **Prompt**: the profile is injected after the persona under an "About Tony" heading.

## 8. Digest

A seed job `self-improvement-digest` (cron `30 21 * * *`, `context: light`, `deliver: [auto]`,
installed **disabled**) whose prompt lists today's `agent_improvements` (applied with undo links
to the revision pages; pending review count) and replies `NO_REPLY` when there were none. The data
comes from a read-only tool `list_improvements({ since })` (read class).

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| Reflector error / invalid JSON | retry on the next tick once; then advance the watermark with no proposals |
| Jev down | proposals route to `/review` (fail closed) |
| CAS conflict on apply | `conflict` → `/review` with the fresh content shown |
| Proposal targets a deleted skill/job | `dropped` (`target_missing`) |
| Signal writer error | logged; never affects the user's turn |
| Mode switched to `off` mid-pass | the gate re-reads the mode before applying |

## 10. Security

- The reflector has no tools; injected transcript text can only become a proposal, which must pass
  evidence, tiers, sensitivity, Jev and caps.
- Skills are prompt text only; they cannot enable tools or change approvals.
- Profile changes always need Tony's approval; the profile has a hard prompt budget.
- The digest tool is read-only; `/review` actions are session-authed like existing review routes.

## 11. Testing

- **Pure**: evidence check, tier routing, sensitivity, Jev bump, caps, similarity for rejection
  memory, signal classification, profile budget.
- **Reflector**: stubbed model returning fixed proposals; zod rejects malformed output.
- **DB** (scoped per the shared-dev-DB rules): watermark advance; apply + revision + provenance;
  review approve/reject; 30-day rejection memory; CAS conflict; signals written by the inbound and
  main-thread paths; nightly job pass skips < 5 signals.
- **Eval set**: ~20 hand-written threads (`scripts/data/reflect-eval.jsonl`) each labelled with the
  expected proposal kind/target or "none"; a script runs the real reflector once before shipping
  and reports precision on "none" (the reflector must mostly stay quiet).
- **Browser** (`playwright-cli`): Settings → Profile edit/save/revert; `/voice` redirect and
  Settings → Voice renders; `/review` self-improvement card approve/reject; "learned" badge on a
  skill revision.

## 12. Out of scope

Persona edits by reflection; calibrating Jev thresholds (needs labels from this cycle's reviews);
cross-conversation pattern mining beyond one thread; reflection over Claude Code sessions (the
memory enrichment already covers them).
