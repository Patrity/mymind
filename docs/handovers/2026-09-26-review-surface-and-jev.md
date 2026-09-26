---
title: Review surface gets real verbs, and Jev becomes a second opinion on memory
cycle: 72
date: 2026-09-26
status: shipped
branch: master
merged: true
deployed: true
specs: []
plans: []
wiki:
  - ../wiki/memory.md
  - ../wiki/agent.md
  - ../wiki/ai-providers.md
migrations:
  - 0053 memories.jev_score / jev_answers / jev_scored_at / jev_model
migrations_run_on_prod: true
---

# Cycle 72 — the review surface, and Jev as a second opinion

Unplanned follow-on from cycles 70/71, driven entirely by Tony using the shipped features
and reporting what was wrong. **Merged and deployed to prod** (cycles 70 and 71 shipped with
it — see their handovers). Migrations 0046–0053 are applied to prod.

## What prompted it

Cycles 70 and 71 merged, then Tony used them. Six things came back, in this order: the slash
menu wasn't a real popover, Tab didn't select, focus didn't return to the input, a skill
invocation was rewritten into a sentence, the `/clear` divider vanished on reload, and the
review queue had exactly one button. Each is small; together they are the difference between
a feature existing and a feature being usable.

Then a bigger question: *are these memories even worth reviewing?* That produced an audit
whose result reframed the rest of the work — see [The memory audit](#the-memory-audit) below.

## The slash menu (cycle 71 follow-ups)

- **It is a real popover now.** It sat in the flow, so every keystroke grew the input block and
  shoved the conversation up — which reads as the composer breaking rather than a menu opening.
- **It was then invisible for one deploy**, and that is the part worth remembering. Floating it
  put it *above* the composer but still INSIDE `<PromptInput>`, whose vendored
  `<InputGroup class="overflow-hidden">` clips the rounded corners — and everything above the
  box with them. The menu was in the DOM, 8 rows, with a perfectly correct bounding rect, and
  nothing on screen. **The browser check passed because it asserted
  `getBoundingClientRect`, which reports geometry for clipped elements.** It is now a sibling
  of `<PromptInput>` in a relative wrapper, the check hit-tests rows with `elementFromPoint`,
  and a unit test pins the menu's position in the markup.
- **Tab completes** the highlight, and selecting by Tab, Enter or click puts focus back in the
  textarea (a click moved focus to the `<li>`, so the next keystroke went nowhere).
- **Rows are a name and one truncated description.** The "Use when …" hint wrapped every row to
  two or three lines and buried the names the menu exists to let you scan.
- **A skill invocation goes through verbatim** — `/db-maintenance`, not `Use the db-maintenance
  skill.`. Substituting a sentence fixed an earlier emptiness bug but erased the command, so
  neither the transcript, a fork/edit replay, nor the model reading its own history could tell
  a slash command had been used.

## `/clear` survives a reload

The divider was rebuilt from `cleared` WS frames alone, so it lived exactly as long as the tab
that ran the command. After a reload you read pre-clear messages Bridget cannot see, with
nothing saying so — the precise divergence the divider exists to prevent.

`ConversationDTO` now carries `contextEpochAt`, and the divider is **derived** from it
(`app/lib/agent/dividers.ts`) for both the live and reloaded case, so the two cannot drift.
One epoch per conversation, because the column holds one: clearing twice moves the boundary
rather than adding a second one.

## The review surface

| Before | After |
|---|---|
| No project on any card | `📁 project` badge on memories **and** conflicts |
| Conflicts: "keep both" / "accept" | Four outcomes behind a dropdown |
| Memories: "Mark reviewed" only | **Discard** as well, archived with an Undo toast |

**Why four outcomes.** Two buttons assumed the new memory is always the better one. It often
isn't — enrichment can produce a worse restatement of a fact you already had, and both sides
can be stale. Neither case had a button. `archivalPlan` (`server/lib/review/conflict-resolution.ts`)
is a pure function with its own tests because inverting it would silently archive the memory
the user chose to keep.

**Why Discard matters more than it looks.** `assembleContext` searches with `reviewed: true`,
so "Mark reviewed" is precisely what lets Bridget see a memory. With that as the only exit, the
queue could **promote junk into her context but never shed it**.

`POST /api/agent/undo` takes `{ token }`, **not** `{ undoToken }` — its zod schema rejects the
latter with a 500. The archive response's field is named `undoToken`, so the asymmetry is easy
to get wrong.

## Jev as a second opinion

`memories.confidence` is the enrichment writer grading its own work. Jev is an independent read
of the same text, stored beside it and oriented the same way (**higher = more likely worth
keeping**), so a gap between the two is the signal worth looking at.

**It sorts. It does not decide.** That limit is measured, not cautious. Against the 28 hand
labels from the 2026-09-22 sample:

| Signal | Predicts | AUC | 95% CI |
|---|---|---|---|
| `transient` | noise | **0.81** | [0.62, 0.96] — the only significant one |
| `rederivable` | noise | 0.62 | [0.19, 0.89] |
| `value` (holistic score) | noise | **0.27** | anti-correlated |

The pattern is that **observable** questions carry signal and the **taste** question does not —
"how valuable is this?" asks Jev to guess Tony's judgement rather than read the text. It is not
asked at all, and a test fails if anyone re-adds it.

Ordering needs only to beat random, and 0.81 clears that. A drop threshold needs calibration,
and with 4 noise examples every cutoff priced out **at or below the 43% base rate** — it would
have discarded more keepers than junk. So nothing archives anything automatically.

- `server/lib/memory/jev-score.ts` — the questions (pinned to the wording the calibration used)
  and `jevKeepScore`, a pure weighting dominated by `transient`. The raw Noul answers are stored
  in `jev_answers`, so a better weighting once there are more labels is a **recompute**, not
  2,600 more API calls.
- `compareByJev` — worst-first, unscored last (unknown is not bad), newest-first on a tie.
- `server/tasks/score-memories.ts` — cron at `5-59/15`, i.e. *after* `enrich-memories` on the
  quarter hour rather than racing it. Self-gating, idempotent, no-ops when unconfigured.

**Live result on prod:** the worst-ranked unreviewed memories are pending/parked/unstarted
status notes and a dated CB-4 delta; the best are a wristband ASIN with dimensions,
`MSYS_NO_PATHCONV=1` on Git Bash, and a macOS print-scale setting. Most of the junk sits at
`0.70` confidence — enrichment was *confident* about facts that are true today and worthless in
a month. That gap is the whole reason for the second column.

### Jev's credential lives in the model config

First attempt put `JEV_KEY` in `/opt/mymind/.env.native`, which made it the one model secret not
editable from Settings and only changeable over SSH. `jev` is now a usage like any other,
resolved through `resolveChain('jev')` the way `rerank` already is. The env key was removed
from prod.

`jev-latest` rather than a pinned version: the API **echoes back which version answered**
(`{"model":"jev-1.13.0", …}` for a `jev-latest` request), and `memories.jev_model` stores that.
Upgrades arrive automatically and every score still records the model that produced it, so a
future calibration can segment by version rather than assume it carries over.

### The bug that added usage exposed

The assignments schema **required** every usage key, so any config written before a new usage
existed failed to parse — and a parse failure surfaces as "AI not configured", so the entire
provider and model set appears to vanish and the app redirects to `/onboarding`. Adding `jev`
reproduced exactly that against a real config. Every usage now defaults to empty, on both the
stored-doc schema and the PUT. This is the failure mode in the open *"Harden AI config loading"*
task; that task can now be closed for this cause.

## The memory audit

Asked whether the corpus is worth the review effort. Measured on prod:

- **1,389 `enrich-memories` runs vs 4 `search_memories` calls in 30 days** — a 280:1
  write-to-read ratio. The store is close to write-only.
- **92% of live memories are `agent` scope**, averaging 162 chars — mostly project inventory
  (`ACP backend runs on port 3420`) that a grep answers faster and that rots. 212 contain a
  version number, 47 a host or port.
- **Only 80 memories (3%) are `user` scope.** For the proactive Bridget that is the entire
  valuable layer, and it is the only layer not re-derivable from the repos.
- By Tony's own labels, **~43% of the corpus is stale or noise** (16 keep / 8 stale / 4 noise).
- **Retrieval is bimodal.** "prod build runs out of memory during the nitro phase" returns
  exactly the right memory first. "what should I work on next on mymind" returns six memories
  that are *topically* about MyMind and answer nothing.

The reranker is **not** the cause of that second case. It is live (`192.168.2.25:8883`,
assigned, wired into `searchMemories`) and working: on a lookup it separates cleanly
(1.000 / 0.649 / 0.228). On an intent question it ranks the answer **last**, because
"what should I work on" does not lexically resemble "cycle 70 follow-ups still open" — it
resembles anything containing "MyMind". It is a topical-similarity model doing its job; the job
is the wrong one for open-ended queries. **The fix is routing by intent before retrieval** —
"what should I work on" is a tasks-and-handovers query, not a memory-similarity one.

Conclusion reached with Tony, correcting an earlier recommendation of mine: **do not cut the
write rate.** A memory not written is unrecoverable, a memory written but unread costs one row,
and retrieval count is the only measured signal of value. Write liberally, gate hard at
retrieval, let usage teach you.

## The applicability backfill (cycle 70's dormant half)

Run against prod: 2,301 live project-tagged memories classified in 66s for $0.03 →
**27 set to `global`** (1.2%), 104 confirmed `project`, 2,170 no-ops. Well under the script's
25% sanity bar. The promoted set is right and genuinely cross-project: `Tony works for NLS`,
Gulf Coast insurance, portable-AC physics, the git-worktree and PowerShell gotchas.

1.2% is a thin yield, and the script's own Ruling 18 predicted it: the noul distribution is too
compressed to gate confidently, and real global promotion should come from the **retrieval-count**
path — a memory actually reused across projects — which needs the `resident` writer that is
still unbuilt.

## The secret incident

GitHub push protection blocked the first merge attempt: `scripts/data/applicability-backfill-2026-09-24.jsonl:9`
held a live OpenRouter API key, because a stored memory's content was literally
`"User's OpenRouter API key is sk-or-…"` and the backfill script dumps every memory's content to
JSONL. **Four such dumps across four commits carried 1,867 raw memory contents toward a PUBLIC
repo.** History was rewritten to drop `scripts/data` from all of them and the directory is now
gitignored; nothing reached origin. Rotation was not needed (inference is local and it was never
published). Backup tag: `pre-secret-rewrite`.

**The general hazard: any script that dumps memory contents to a file is dumping personal data.**

## Deferred

- **Intent routing before retrieval** — the single highest-value item from the audit. Open
  questions should hit tasks/handovers, not memory similarity.
- **An interview skill** so Bridget can grow the `user` layer deliberately. 80 memories is too
  thin for her to know Tony, and it is the only layer not re-derivable from the repos. Caution
  worth designing around: an interview run by a model already holding 2,600 memories will ask
  leading questions and record its own paraphrase — it should quote Tony rather than summarise.
- **Jev cannot spot the non-transient kind of junk** — a durable-sounding fact that is simply
  wrong or redundant. Those still sit mid-pack. Closing that needs more labels of the droppable
  class; 4 noise examples is the binding constraint, not the model.
- Everything still open from cycles 70/71 — see that handover and the MyMind task.
