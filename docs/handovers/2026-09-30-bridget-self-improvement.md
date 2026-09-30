---
title: Bridget self-improvement — a tool-less reflector, a proposal gate, the About Tony profile, job tuning from engagement signals, and review tools (cycle 76)
cycle: 76
date: 2026-09-30
status: built
branch: feat/bridget-self-improvement (worktree .claude/worktrees/self-improvement, base d933724)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-09-30-bridget-self-improvement-design.md
plans:
  - ../superpowers/plans/2026-09-30-bridget-self-improvement.md
wiki:
  - ../wiki/self-improvement.md
  - ../wiki/agent-skills.md
  - ../wiki/agent-jobs.md
  - ../wiki/memory.md
  - ../wiki/voice-studio.md
migrations:
  - 0063 agent_profile, agent_signals, agent_improvements; conversations.reflected_through; agent_config_revisions.improvement_id
migrations_run_on_prod: false  # 0063 applied on dev only; prod runs through 0062 (cycles 73–75 + the reliability pass deployed)
seed_jobs_enabled: false  # all five seeds, including the new self-improvement-digest, install DISABLED
acceptance: passed  # scenarios 1–5 (playwright-cli, dev :3076, 2026-09-30); scenario 3 passed after the Task 11a fix
eval: { none_precision: "10/10", kind_hit_rate: "10/10", exact_slug_hit_rate: "5/10" }
final_review: pending
prod_agent_timezone: America/Chicago
mymind_task: null  # not mirrored — this session had no MCP/prod writes
---

# Cycle 76: Bridget self-improvement

Cycles 73–75 made Bridget always-on. Cycle 76 adds learning from experience in a **separate,
restricted pass**.

- A tool-less **reflector** reads each settled thread and proposes new or edited **skills** and
  edits to the **About Tony profile**.
- A nightly pass reads **engagement signals** on her job messages (replied, tapbacks, "stop",
  "thanks", ignored) and proposes **job** edits or pauses.
- Plain code **gates** every proposal. The checks are: verbatim evidence, 30-day rejection
  memory, validity, tiers, sensitivity, a one-way Jev check, and daily caps.
- A proposal that passes is applied with provenance (the "learned" badge), sent to `/review`, or
  dropped.

Tony can also work the `/review` queue from chat: `list_reviews`, and `decide_review`, which he
confirms on every call. The profile has its own page (**Settings → Profile**), and the voice
studio moved to **Settings → Voice**.

How it works today: [wiki/self-improvement.md](../wiki/self-improvement.md).

## What shipped (on the branch)

| Task | Commits | What |
|---|---|---|
| 1 | 45e3414 | Schema 0063 (profile, signals, improvements, `reflected_through`, `improvement_id`); `RevisionTargetKind` gains `profile` |
| 2 | 95c7231, dd63fb7 | Profile store, API and prompt injection (`## About Tony`, clamped to 1,500 tokens); lazy create under an advisory lock |
| 3 | 8b3d15c | Settings → Profile (shared editor, token meter, starter), Settings → Voice (`/voice` redirects), Settings → Bridget self-improvement mode |
| 4 | b9758ec, 92e10a0 | Engagement signals: observation windows, reply/stop/thanks, tapbacks, `ignored` on close |
| 5 | 149f512, 442b370, 64a9d0a | Reflector core: candidates, transcript, prompt, tolerant parsing |
| 6 | 510b848, 409892a, d8a713b | The pure gate and the one-way Jev check |
| 7 | f70f4d6, 3a90e0b | Thread and jobs passes, apply with provenance and CAS, the `self-improvement` review kind |
| 8 | a4d20b7, d058aa3 | Nitro tasks `reflect-threads` (*/15) and `reflect-jobs` (hourly, once a day); `pnpm reflect:eval` with 20 hand-written rows |
| 9 | 85099f0, 46c3f52 | `reviewChoices` registry, `decideReview` service, `list_reviews` / `decide_review`; approval allowlist opt-in per tool |
| 10 | 20e5f3e | `list_improvements`, `self-improvement-digest` seed (disabled), learned badge |
| 11 | dc10fca | `reflect:eval` gets a real `$fetch` shim (plain `fetch` failed every call) |
| 11a | 7ceb6cc, 7dd80d6, f04ec2a | Approval-card race fix; reflector prompt splits lessons by kind; `tsx` is a devDependency |
| 11 | (this commit) | Wiki, handover, roadmap |

## Gates (at the docs commit)

| Gate | Result |
|---|---|
| `pnpm test` | 291 files, **2967 passed / 1 skipped** |
| `pnpm test:db` (full) | 73 files, **768 passed**; the dev DB matches the baseline afterwards |
| `pnpm typecheck` | clean |
| `pnpm build` | green |

## Eval (`pnpm reflect:eval`, one real run, before Task 11a's prompt change)

- precision on "none" rows: **10/10**;
- kind-level hit rate: **10/10**;
- exact kind + slug: **5/10**.

All five slug misses were `skill.create` with a sensible, different slug (for example
`restart-mymind-app` for `restarting-prod-mymind`). The exact-slug score measures the eval's
matching more than the reflector. It has not been re-run since the Task 11a prompt change.

## Acceptance (playwright-cli, dev on :3076 with `BETTER_AUTH_URL=http://localhost:3076`)

**Setup.**
- `self_improvement_mode` was set to `off` for the whole session, so the dev server's cron
  reflected on nothing.
- The one real reflector call was made through the seam:
  `runThreadPass({ onlyConversationIds: [scratch], now: +31 min })`, from a one-off `tsx` script
  that set the mode to `on` for that call only.
- Each scratch thread was opened with **New conversation** first. `/agent` opens the most recent
  thread, and Task 11a once wrote into a real one by mistake.

1. **Correction → skill, preference → profile (one real reflector call).** The scratch thread
   contained "no — always put receipts in /finance/receipts" and "Also, I prefer bullet points
   over paragraphs." The real reflector returned **one `profile.edit` combining both lessons**; it
   did not propose a `skill.create`.
   - Evidence was both quotes, verbatim, so the evidence check passed.
   - Jev: inferred 0.10, passing 0.16, not risky.
   - Route `review`, reason `tier`.
   - The first attempt, before 11a's prompt change, merged them the same way. The spec accepts
     routing to review. **Known limit:** the skill auto-apply path and the learned badge on a
     *skill* were not exercised by a real run (they are covered by DB tests).
2. **Profile proposal → `/review` → Settings → Profile.** The card showed the kind, the target
   link, 100% confidence, a diff, both evidence quotes, the source-thread link, the `tier` chip
   and the Jev answers. **Approve** set the improvement to `applied` and wrote revision
   `13456636` (actor `human`, `improvement_id` set). `/settings/profile` showed the new content,
   the meter at 51/1500, and one revision tagged **human · learned**.
3. **Review tools in chat.**
   - "What's in my review queue?": `list_reviews({kind:'self-improvement'})` returned 2 items
     with Approve/Reject choices, and Bridget relayed them.
   - "Approve item … with decide_review": the **approval card appeared** ("Decide review ·
     Awaiting Approval · Run this? approve — profile.edit profile: …", with no "always allow").
   - **Deny** returned `{denied:true}`. The item stayed `pending`, the profile hash and revision
     count were unchanged, and the audit event was `outcome: deny, remembered: false`.
   - The first Task 11 run failed here: the card never rendered. See "Approval-card race" below.
4. **Voice move.** `/voice` lands on `/settings/voice`, and the studio renders.
5. **Mode off.** Settings → Bridget showed "Off". The pass on a candidate scratch thread returned
   `{threads:0, proposals:0}`: the watermark was unchanged, no improvement was written, and no
   model call was made.

**Cleanup.** Everything I created was deleted, and the dev DB matches the pre-acceptance
baseline exactly:
- deleted: the 2 scratch threads with their messages and runs, the improvement, the review item,
  the profile revision, and a memory Bridget saved with `save_memory`;
- restored: the profile row, byte for byte, including `updated_at`;
- removed: the mode row, which was absent at baseline.

| | before | after |
|---|---|---|
| agent_improvements | 1 | 1 |
| review_queue (pending) | 44 (33) | 44 (33) |
| conversations / messages | 25 / 146 | 25 / 146 |
| memories | 1662 | 1662 |
| agent_skills / config revisions (profile) | 6 / 31 (0) | 6 / 31 (0) |
| agent_runs / agent_signals | 42 / 0 | 42 / 0 |
| seed jobs | 5, all disabled | 5, all disabled |

## ⚠️ A dev server on this branch reflects over the whole dev DB

`reflect-threads` runs every 15 minutes and `reflect-jobs` hourly, whenever a dev server on this
branch is up. **Unless `self_improvement_mode` is `off`, they reflect over real dev threads,
including main.** This already happened during the build: improvement **`fc6947d5`**
(profile.edit, pending_review, from conversation `9cf3591f`, 18:30Z) came from real dev threads.
The same run moved main's `reflected_through`, and `reflect_jobs_last_date` was written at 17:40Z.
Both were left as they are (dev data).

For acceptance or debugging, set the mode to `off` first:

```sql
insert into settings(key, value, updated_at) values ('self_improvement_mode', '"off"', now())
  on conflict (key) do update set value = excluded.value;
```

Then call the pass through its seam (`onlyConversationIds`, `onlyJobSlugs`). This also matters in
prod once merged: the first `reflect-threads` tick reflects over every thread active in the last
7 days, 5 per tick.

## Deviations from the spec (every ruling from the SDD ledger)

**Preflight**
- **Ruling 1:** the self-improvement approve handler signals a CAS conflict by throwing 409
  `{current}`. `decideReview` maps a 409 to `{ok:false, reason:'conflict'}`, and the route keeps
  returning 409.
- **Ruling 2:** `reflect-jobs` runs at `'40 * * * *'`. It fires when the agent-timezone hour is
  ≥ 3 and `reflect_jobs_last_date` ≠ today, so it normally runs at 03:40 local, and a missed hour
  still runs later that day. This replaces the plan's 03:30 (Nitro cron is UTC).

**Task 2**
- Accept the `agentProfile` live resource and its dispatch mapping.
- The lazy singleton create runs under `pg_advisory_xact_lock` with a re-select, and reads take
  the oldest row.
- `saveProfileSource`'s lazy insert reuses the locked helper.

**Task 3**
- Accept `settingsPanel:false` page meta (full-height settings children).
- Accept the Task 2 test `afterAll` fix (it would have lost a real profile).

**Task 4**
- `closeObservations` judges only job messages created after `signals_started_at` (written on the
  first call) and within 14 days.
- Accept the queue hook on every `trigger:'user'` enqueue; `noteUserReply` checks main itself.
- `noteTapback` applies the allowlist and direct-chat checks, like `resolveTapback`.
- Accept `resolveTapback` returning a boolean.
- Fix-round items: `noteTapback` is fire-and-forget; `noteUserReply` never creates main;
  `said_stop`/`said_thanks` are recorded even when the message is already `replied`; a
  negation/hyphen guard.

**Task 5**
- `threadCandidates` has a 7-day recency floor.
- Accept counting only user/assistant rows toward ≥ 4.
- Accept the 2 h cool-down measured from `reflected_through`.
- Accept replies starting "None" as no proposals.
- Fix round: fence-safe parsing, successive bracket starts, trailing-comma repair only outside
  strings, size limits in the prompt.
- **Evidence uses the transcript only** (for the jobs pass, the signal snippets), never the skills
  or profile that were also in the prompt.

**Task 6**
- Accept reason code `tier`. Sensitive and Jev reasons are noted even when the item is already in
  review. Jev missing any answer counts as `unavailable`.
- Jev's state is the proposal plus its own evidence quotes, not the transcript.
- `SENSITIVE` matches stems and plurals.
- **Rejection memory compares deltas** (lines added or changed against the target at pass time).
  Empty deltas never match.
- A `skill.create` whose slug exists is treated as a `skill.edit` of it.
- Evidence quotes under 12 normalised chars are dropped (`evidence_too_short`).
- Carried to Task 7: store the rejection delta. A `job.disable` is remembered by kind and target
  and dropped pre-gate if it was rejected within 30 days. Accepted: "command palette" matches
  SENSITIVE (the false positive only routes to review).

**Task 7**
- `conflict` is non-terminal (the item stays pending).
- Apply rewrites the skill's `source:` line: agent on a create, the existing author on an edit.
- A non-conflict auto-apply failure → dropped (`apply_failed`). The improvement carries
  `conversationId`, and the rejection delta lives in `proposal.delta`.
- **Any `job.edit` that changes `enabled`, in either direction, goes to review.**
- **Jobs-pass evidence is the signal snippets only**, never the job's own file.
- The thread prompt includes each active skill's full file, truncated to 2 KB (16 KB total).
  Skills that don't fit are listed by name, and an edit of one of them is dropped
  (`invalid: body_not_shown`).
- The CAS hash and diff base are read **before** the model call. A conflict refresh re-derives
  the `source:` line.
- Minors taken: the mode is re-read after Jev; a non-conflict approve error returns a clean 422
  "Could not apply: …"; `job.edit` tests; skill.create and skill.edit form one family in the
  rejection memory; the auto cap counts improvements whose revision actor is `agent`.

**Task 8**
- Accept force-adding `scripts/data/reflect-eval.jsonl` (synthetic). A `.gitignore` carve-out is
  owed in the final wave.

**Task 9**
- Accept `decideReview`'s `{route:true}` option, the extra `DecisionResult` fields, and the lazy
  import (breaks an import cycle).
- A failed agent-action replay returns `ok:true` with an explanatory summary (the page's existing
  behaviour).
- `memory-unreviewed` choices are labelled "Mark reviewed" / "Discard", and the page renders them
  from the registry.
- **The approval allowlist is opt-in per tool.** `AgentTool.allowlistable` is true only for exec.
  `approvalFor` ignores saved patterns for other tools, `ws.ts` refuses to save an "always allow"
  for them, and the card hides the option.
- Conflict resolve has a pending guard.

**Task 10:** no rulings.

**Task 11 / 11a**
- **Approval-card race, fixed at the stream level.** `ui-stream.ts` never re-sends
  `tool-input-available` for a call that is already open, and the approval request carries the
  (masked) args, so the card renders even when the request beats `tool-start`. Before the fix, a
  dangerous tool with no await before `requestApproval` (`decide_review`) showed "Running" and
  timed out. A regression test feeds both orders through the real encoder and
  `readUIMessageStream`.
- The reflector prompt gains: "one proposal per distinct lesson; a procedure is a skill, a
  preference is a profile edit". In the real acceptance run it still merged them (known limit
  below).
- `tsx` is a devDependency, so `pnpm reflect:eval` runs in any checkout.

## Follow-ups (every deferred or parked item)

**Final wave (named):**
- **The iMessage approval prompt reads "Run …?" for `decide_review`.** It should read as a review
  decision.
- The exec-approvals settings save stores inert rules for any tool.
- The audit event logs the client-supplied pattern.
- `.gitignore` carve-out for `scripts/data/reflect-eval.jsonl`.
- Cap the approval-card args with `capArgs` in `ws.ts` (11a).
- A reused tool-call id drops the second `tool-start` (11a).
- The new prompt line partly repeats `prompt.ts:69` (11a).

**Deferred minors:**
- Task 2: the CAS/revert shape is duplicated from skills (codebase precedent).
- Task 3: the starter template re-inserts after an intentional empty save; a mode change sends no
  live event.
- Task 4: a fixed 300 ms wait in a wake test.
- Task 5: `[event]` rows are shown in the transcript but not counted; `slice(-0)` edge.
- Task 6: an unused `1-v` unwanted-low branch; the 1–2-word similarity edge.
- Task 7: retry bookkeeping detail; test coupling to the global mode; an extra `getSkillSource`
  read per skill; a lost create race in `saveSkillSource` becomes `apply_failed`, not `conflict`.
- Task 8: `hourIn` duplicates a one-liner in `prompt.ts`; the eval script's no-DB-write property
  is incidental.
- Task 9: the card ignores `tone`; the 409/422 mapping is not scoped to `self-improvement`;
  services import from `api/`; a redundant id union.
- Task 10: document that `pendingReview` is live (not scoped by `since`). Now done in the wiki.

**Found at acceptance:**
- **The reflector merges lessons.** A receipts *procedure* and a formatting *preference* came
  back as one `profile.edit` in both real runs, before and after 11a's prompt line. It is safe,
  because the profile always goes to review, but procedures don't become skills. Next step: add
  eval rows that mix a procedure with a preference and score the split, then consider a stronger
  prompt or a split step in code.
- **The eval hasn't been re-run since the prompt change,** and exact-slug matching undercounts.
  Consider scoring on kind only, or accepting any slug for `skill.create`.
- **Out of scope (spec §12):** Jev threshold calibration, which needs this cycle's review labels;
  and reflection over Claude Code sessions.

## Deploying (when merged)

1. Take a DB backup to `/root/db-backups` (gzipped). CD migrates **0063** (additive).
2. **Decide the mode before the first tick.** With the default `on`, the first `reflect-threads`
   tick reflects over every prod thread active in the last 7 days (5 per tick). Nothing
   auto-applies to the profile or to Tony's skills and jobs, but new agent skills can. Setting
   `review_only` for the first days sends everything through `/review`.
3. The seeds stay disabled. Enable `self-improvement-digest` on `/jobs` if wanted.
4. Signals start at the first `closeObservations` (`signals_started_at`). Job tuning needs 5 or
   more signals per job in 14 days, so the first job proposals come later.
5. Smoke test: Settings → Profile loads and saves; `/voice` redirects; `/review` renders a
   `self-improvement` card; `decide_review` in chat shows the approval card.

## Where cycle 77 starts

Merge after the final review wave (the follow-ups above). Watch the first week of
`agent_improvements`: the drop reasons (is the reflector quoting badly?), the review-versus-auto
ratio, and whether any skill is auto-applied. Then calibrate the Jev thresholds from the rejected
versus approved labels.
