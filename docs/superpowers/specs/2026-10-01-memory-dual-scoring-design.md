---
title: "Memory dual scoring — an improved extraction prompt, an LLM audit and Jev on every memory, a backfill, and doc routing (cycle 77)"
cycle: 77
date: 2026-10-01
status: spec
supersedes: null
builds_on: 2026-09-30-bridget-self-improvement-design.md
---

# Memory dual scoring (cycle 77)

Tony noticed in `/review` that Jev's score is often more right than the extractor's LLM confidence
(e.g. "heatwave-site has a pending Plan B … requires generating VAPID keys" — Jev 0.35, a memory that
will be stale within weeks). Prod data (2026-10-01): 2,453 of 2,613 enrichment memories (94%) were
extracted with confidence ≥ 0.75 and auto-reviewed — the LLM confidence barely discriminates — and
**Jev has scored only the 98 queued memories**, never the auto-reviewed ones. Cycle 72 measured Jev
on 28 labels: only the `transient` question carried signal (AUC 0.81, wide CI).

This cycle is **measurement, not policy**: make extraction better, put two current, comparable
scores on every memory, backfill them, and give Tony and Claude the data to analyse together.
Gating changes are decided afterwards.

## 1. Decisions (brainstorm, 2026-10-01)

| # | Decision | Rejected |
|---|---|---|
| D1 | Improve the extraction prompt (`extract-v3`): reject time-sensitive/stale/pending/in-flux facts and doc-worthy detail; require single, self-contained, six-months-useful facts; explicit confidence anchors. | leave the prompt |
| D2 | Two current scores on every memory: **Jev** (all live memories, not only queued) and a new **LLM audit** using the `extract-v3` criteria. The original extraction confidence stays as a historical number. | Jev only on old memories; re-score a sample |
| D3 | A resumable, capped background **backfill** scores every live memory with both; started by a switch Tony flips on prod. | one-shot script |
| D4 | `/memories` shows both scores (like `/review`), with sort/filter by each and by disagreement. | review page only |
| D5 | **No automatic action** this cycle: no auto-archive, no new gating, no cleanup actions. After the backfill Tony and Claude analyse the export and decide next steps. | archive where both agree; Jev-only archive |
| D6 | The extractor gains a **`doc_candidate`** output for doc-worthy detail, filed as a capture into the existing **triage** pipeline (which proposes appends/notes via `/review`). Never a direct document write. A candidate whose target doc is mirrored from the repo becomes a plain note. Backfill only *labels* old memories `belongs_in_doc`. | direct doc writes; not routing at all |

## 2. Data — migration 0064 (additive)

`memories` gains: `audit_keep real` (0–1 durability per `extract-v3`), `audit_verdict text`
(`keep` | `transient` | `redundant` | `wrong_scope` | `belongs_in_doc`), `audit_reason text`,
`audit_model text`, `audit_prompt_version text`, `audited_at timestamptz`, `audit_failures int
default 0`, `extract_prompt_version text` (stamped on new memories), `jev_failures int default 0`.

Setting `memory_backfill`: `{ state: 'off' | 'running' | 'done', startedAt, finishedAt }`. Progress
is derived by query (counts of live memories missing a Jev score / an `extract-v3` audit; skipped =
failures ≥ 3).

## 3. Extraction prompt `extract-v3`

Single source of truth for "a good memory", shared by extraction and the audit:
- **Reject — time-sensitive or likely stale:** pending/planned work ("has a pending Plan B", "next
  we'll …"); in-progress project states; versions, counts, prices, dates expected to change;
  "currently/now/today" facts; TODOs and procedures-to-do.
- **Reject — belongs in a document:** architecture detail, spec/handover content, multi-step how-tos
  → emit as `doc_candidate` instead.
- **Require:** a single fact; self-contained (names the project/thing); useful in six months.
- **Confidence anchors:** 0.9 stable fact about Tony or the system; 0.7 durable but could change
  this year; 0.5 likely to change within weeks; < 0.4 do not extract.
- Output: `{ memories: [...existing shape], doc_candidates: [{ text, project?, targetDocHint? }] }`.
  The parser stays tolerant; missing `doc_candidates` = none.

The **audit prompt** gives the model one existing memory (content, project, age) and the same
criteria, and returns `{ keep: 0–1, verdict, reason }` (reason ≤ 200 chars).

## 4. Scoring

- **New memories:** after extraction + creation, Jev and the audit run for the new rows
  (fire-and-forget; failures leave them for the backfill). Auto-review behaviour is unchanged
  (still the extraction confidence threshold).
- **Backfill** (Nitro task every 5 min while `state = 'running'`): up to 40 live memories per run,
  oldest first, missing a Jev score or an `extract-v3` audit. Jev concurrency 6 (existing scorer),
  audit concurrency 2 (bulk chain). Failures increment the row's failure counter; ≥ 3 → skipped.
  When nothing is left, `state = 'done'`.
- The queue scorer (`score-memories`) keeps working; it and the backfill share one scoring function.

## 5. Doc candidates → triage

Each `doc_candidate` becomes a capture through the existing capture service (the path
`quick_capture` uses), tagged with the project and a hint, source `memory-enrichment`. The triage
task proposes append/note/task as today, through `/review`. Guard: if the hinted/target doc is
mirrored from a repo file, the capture is filed as a note proposal, never an append.

## 6. UI

- **`/memories`:** columns *LLM audit* and *Jev* (colour-coded; tooltip shows verdict + reason /
  raw Jev answers); the extraction confidence as a small "at extraction" number. Filters: verdict;
  scored / not yet scored; "disagree" (|audit_keep − jev_keep| ≥ 0.4). Sorts: each score;
  disagreement. Reuses the `/review` score display component.
- **Backfill control:** a card (Settings → Memory, or the existing analytics/memory settings area)
  with Start / Pause, live progress (scored / total, skipped, ETA), and last error.

## 7. Analysis export

`pnpm memory:export` → `scripts/data/memory-scores-<date>.{csv,jsonl}` (gitignored): id, content,
project, created_at, extraction confidence + prompt version, audit keep/verdict/reason, Jev keep +
raw answers, archived/reviewed state, and Tony's labels from the `pnpm label` file when present.
Read-only.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Jev unavailable | memory stays unscored; backfill retries later; extraction never blocked |
| Audit reply unparsable | retry next run; 3 failures → skipped (counter on the row) |
| Triage capture fails | logged; the memory path continues |
| Backfill process crash | resumes from the query (no cursor state to lose) |
| Switch set to `off` | the next tick does nothing |

## 9. Testing

- **Prompt eval** (`pnpm memory:eval`, real model, run once before merge): the 45 labelled rows in
  `scripts/data/memory-labels-2026-09-22.jsonl` plus 20 new hand-written transcript rows (stale /
  pending facts, durable preferences, doc-worthy detail, mixed). Bar: ≥ 90% of expected durable
  memories kept, ≥ 80% of planted stale/pending facts rejected; doc candidates reported.
- **Unit:** v3 parser (incl. `doc_candidates`), audit parser + verdict enum, disagreement, repo-mirror
  guard, backfill selection logic.
- **DB (scoped):** backfill batch/skip-after-3/done; new memories scored; doc candidate → capture.
- **Browser (playwright-cli):** `/memories` columns, filters, sorts, tooltips; backfill card.
- **Acceptance:** one real backfill run limited to 40 memories on dev; the full run happens on prod
  when Tony flips the switch.

## 10. Out of scope

Gating auto-review on Jev/audit, auto-archive, bulk cleanup actions, Jev on conflict cards,
re-extracting old sessions, migrating `belongs_in_doc` memories into documents — all decided after
the backfill analysis.
