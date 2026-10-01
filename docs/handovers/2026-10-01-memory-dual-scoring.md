---
title: Memory dual scoring — extract-v3, an LLM audit and Jev on every memory, a switch-gated backfill, doc routing, and an analysis export (cycle 77)
cycle: 77
date: 2026-10-01
status: built
branch: feat/memory-dual-scoring (worktree .claude/worktrees/memory-dual-scoring, base 9766132)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-10-01-memory-dual-scoring-design.md
plans:
  - ../superpowers/plans/2026-10-01-memory-dual-scoring.md
wiki:
  - ../wiki/memory.md
  - ../wiki/triage.md
migrations:
  - 0064 memories gains audit_keep, audit_verdict, audit_reason, audit_model, audit_prompt_version, audited_at, audit_failures, extract_prompt_version, jev_failures (additive)
migrations_run_on_prod: false  # 0064 applied on dev only; prod runs through 0063 (cycle 76 deployed)
backfill_switch_on_prod: off  # the memory_backfill setting stays absent/off; Tony starts it from Settings → Memory
eval: { keep_rate: "11/11", stale_rejection: "12/12", doc_routing: "3/4", audit_vs_label: "24/45 (53%)", run: "2026-10-01, one real run" }
acceptance: passed  # one real runBackfillBatch({limit:40}) on dev: 40/40 audited, 26 new Jev scores (14 already had one), 0 content failures, 0 transport stops, 20.5 s
final_review: pending
mymind_task: null  # not mirrored — no MCP/prod writes this session
---

# Cycle 77: Memory dual scoring

Tony noticed in `/review` that Jev's score is often more right than the extractor's own confidence.
On prod, 94% of enrichment memories were extracted at confidence ≥ 0.75 and auto-reviewed, and Jev
had scored only the 98 queued memories. This cycle is **measurement, not policy**:

- a better extraction prompt (**extract-v3**) that rejects stale, pending and in-flux facts, and
  routes doc-worthy detail to triage as **doc candidates** instead of memory;
- two current scores on **every** live memory: **Jev**, and a new **LLM audit** that applies the
  extract-v3 criteria to an existing memory. The extraction confidence stays as a historical
  number;
- a resumable, capped **backfill** behind a switch Tony flips;
- both scores, filters, sorts and a disagreement view on `/memories`, and the audit badge on
  `/review`;
- `pnpm memory:export` for the analysis.

**No automatic action** (spec D5): nothing archives, auto-review is unchanged, no content is
edited. Gating is decided after Tony and Claude analyse the prod backfill.

How it works today: [wiki/memory.md](../wiki/memory.md#dual-scoring--extract-v3-the-llm-audit-and-the-backfill-cycle-77)
and the mirror guard in [wiki/triage.md](../wiki/triage.md).

## What shipped (on the branch)

| Task | Commits | What |
|---|---|---|
| 1 | d94a630 | Migration 0064 (audit fields, failure counters, `extract_prompt_version`); `memory_backfill` setting; `MemoryDTO` + `AuditVerdict` |
| 2 | 1b047e4, e54c1d9, a22f707 | `extract-v3` prompt, parser with `doc_candidates`, string-aware `extractBalanced`, version stamp on insert; `pnpm memory:eval` extraction part (22 rows) |
| 3 | 3f42aad | The audit: `audit-v1` prompt restating the extract-v3 criteria, `parseAudit`, `auditMemory`; the eval's audit-vs-labels part |
| 4 | 0520345, a98d3d9, 63211a3, 723d64d, 2fd98bf | One scoring path (`memory-scoring.ts`) for enrichment, the cron and the backfill; `chatWithModel`; content vs transport failures; per-part circuit breakers; shared limiters; first-writer-wins stamps |
| 5 | b836339 | The backfill service, task (`*/5`) and control API; progress and ETA |
| 6 | e731648, b2f7db6 | Doc candidates filed as `/input/` captures into triage; repo-mirror guard on every triage append |
| 7 | a8e65d8, 966a597 | `/memories` scores, filters and sorts; `<MemoryScoreBadges>` shared with `/review` (audit badge there too); Settings → Memory backfill card |
| 8 | ef47b13 + docs | `pnpm memory:export`; acceptance; wiki, handover, roadmap |

## Gates (Task 8, at ef47b13)

| Gate | Result |
|---|---|
| `pnpm test` | 301 files, **3068 passed / 1 skipped** |
| `pnpm test:db` (full) | 78 files, **849 passed**; dev DB counts identical before and after (memories 1,662 / live 1,603, live documents 4, settings 8, review_queue 44). Raw `tasks` rows went 5,878 → 5,892: 14 fixture tasks the existing triage DB tests create and soft-delete (all have `deleted_at`); live tasks unchanged |
| `pnpm typecheck` | clean |
| `pnpm build` | green |

## Eval (`pnpm memory:eval`, one real run, 2026-10-01, 84 s)

**Extraction (extract-v3, 22 rows): the bar is met.**

| Measure | Result | Bar |
|---|---|---|
| durable facts kept | **11/11 (100%)** | ≥ 90% |
| stale/pending facts rejected | **12/12 (100%)** (pure-stale rows with zero memories 8/8; mixed-row stale items not kept 4/4) | ≥ 80% |
| doc routing | 3/4 (row 21, spec content, gave 3 memories and no doc candidate) | reported |
| unexpected doc candidates | 0 | reported |

Row 19 (a multi-step deploy how-to) also produced a memory summarising the procedure, alongside
its doc candidate.

**Audit vs Tony's 45 labels: 24/45 (53%).** There is no bar for this part. Mapping:
keep↔keep, stale↔transient, noise↔redundant|wrong_scope.

| Label | n | Agree | Where the audit went instead |
|---|---|---|---|
| keep | 28 | **22** | 6 × `transient` |
| stale | 12 | **2** | 10 × `keep` (keep 0.60–0.90) |
| noise | 5 | **0** | 3 × `transient`, 2 × `keep` |
| `belongs_in_doc` verdicts | — | 0/45 | — |

Read as keep vs not-keep, agreement is 27/45 (60%). **The audit is lenient on what Tony labelled
stale.** It calls most of them durable conventions or constraints, and calls 6 of his keepers
transient on wording such as "is being replaced", "currently unusable" or cycle numbers. Weigh
the audit with that in mind during the analysis. The prompt was not tuned in this cycle.

## Acceptance (dev, 2026-10-01)

1. **One real backfill batch.** `runBackfillBatch({ limit: 40 })` was run once from a one-off `tsx`
   script, with real Jev and audit calls.
   - The `memory_backfill` setting was **absent** before. It was set to `running` for that call
     only, then the row was deleted, so it is absent again (verified).
   - Result `{ processed: 40, done: false }` in **20.5 s**.
   - **40/40 audited** (`audit_model` qwen3.8-flash-next): 25 `keep`, 14 `transient`,
     1 `belongs_in_doc`.
   - **26 new Jev scores** (`jev-1.13.0`). The other 14 rows were the unreviewed ones the cron
     had already Jev-scored; they needed only the audit.
   - **0 content failures, 0 transport stops**, `lastError` null.
   - The selection order held: all 14 unreviewed live rows were in the batch, and the other 26
     were the oldest reviewed ones.
   - Progress afterwards: 1,603 live, 40 Jev / 40 audited, 1,563 remaining, 0 skipped. The ETA
     read 14 min, which is optimistic (see Follow-ups).
2. **`/memories` shows them** (playwright-cli, dev on :3018, server killed by PID afterwards).
   The badges render as "10% audit · transient · 62% Jev · disagree · 100% at extraction".
   "Disagree only" lists 10 rows. Through the API: `scored=yes` 40, `verdict=transient` 14,
   `verdict=belongs_in_doc` 1, `sort=audit` puts the 0% rows first. Settings → Memory shows
   "paused", 40 / 1603 for both parts, 1563 remaining and 0 skipped.
3. **`pnpm memory:export`** wrote `scripts/data/memory-scores-2026-10-01.{csv,jsonl}`: 1,662 rows
   (1,603 live, 59 archived), 40 with both scores, 10 disagreeing. **Labels joined: 0 of 45.** The
   label ids are prod memory ids, which dev does not have, so they join on prod only.

The dev server was up from 12:23 to 12:26 CDT, across one `*/5` tick. `memory-backfill` was a
no-op then because the switch was absent.

## Deviations from the spec (every ruling from the SDD ledger)

**Preflight**
- **Ruling 1:** Task 2 built the eval script with the extraction part only; Task 3 added the
  audit-vs-labels part to the same script.

**Planning rulings (plan self-review)**
- The `documents` table has no repo-mirror marker, so the guard uses the mirror convention's paths
  (`/projects/*/wiki/`, `/projects/*/handovers/`). Because an append to a mirror is always lost
  on the next sync, the guard covers every triage append, not only doc candidates.
- Queue scoring covers live memories missing a part, unreviewed first. The queue task and the
  backfill share `selectUnscored` / `scoreMemories`. (Narrowed in Task 4: the cron stays
  unreviewed-only, below.)
- The audit runs on the `bulk` chain, like extraction. The `reasoning` alias emits think blocks,
  which `chat()` rejects.

**Task 2**
- Accepted: extraction `maxTokens` 1600; the string-aware `extractBalanced` fix, which also
  benefits `parseMemories`. `runMemoryEnrichment`'s wiring is covered by typecheck plus the
  `resolveEnrichedMemory` stamp test.
- The controller copied the gitignored label and sample files into the worktree's
  `scripts/data` for Tasks 3 and 8 (local only).
- Review fixes: pure-stale eval rows are scored by "zero memories kept", and mixed rows keep
  keyword checks with ≥ 2 distinctive keywords. The prompt adds "judge the fact, not its wording"
  ("from now on…" preferences and "we decided X because Y" are durable), with 2 eval rows for
  them. The anchors are aligned with the 0.6 parse floor (below 0.6, do not extract). The
  "precisely observed ≠ high confidence" line is restored. There is an escaped-quote test for
  `extractBalanced`. The eval header says it writes `activity_log` rows only. The file-path reject
  is narrowed to transient paths, so stable host and service locations are kept.
  `routeDocCandidates` gets a `.catch`.

**Task 3 (carried into Task 4)**
- `audit_model` records the model that answered. A small `chat()` variant, `chatWithModel`,
  returns `{ text, model }` and `auditMemory` uses it.
- `AUDIT_VERDICTS` is defined once (`memory.ts` imports it from `extract-v3`).
- Accepted: a lenient `reason` (defaults to `''`).

**Task 4**
- Accepted: the `newId` plumbing in `memory-resolve.ts`, `chatFn = chatWithModel`, one
  `publishChange` per stamped row, and the scorer mocked in the enrich-conversations test.
- The **`score-memories` cron keeps scoring UNREVIEWED rows only** (`selectUnscored` gains
  `unreviewedOnly`). The full-population walk over reviewed rows happens only through the
  switch-gated backfill, so that spend starts when Tony flips it (spec D3/D5).
- When Jev is unconfigured (`jevConfig()` null), `selectUnscored` treats the Jev part as not
  needed, so selection can empty and the backfill can reach `done`.
- **Only CONTENT failures count toward the 3-strike cap:** an unparsable or invalid audit reply,
  or a Jev response missing answers. Transport failures (thrown fetch, 429, 5xx, timeout, chain
  exhausted) do not increment. A batch that hits one stops that part early (circuit breaker) and
  leaves the rest for the next run. One module-level limiter for Jev (6) and one for the audit
  (2), shared by every caller.
- Minors taken: stamp only if still missing (guarded update + `.returning()`, publish only when a
  row was stamped); one publish per row per `scoreMemory` call; deduped config resolution; failure
  increments use `live()`.
- **Classification (round 2):** Jev HTTP 400/404/422, and any 4xx other than 401/403/408/429, is
  content (charged). Jev 401/403 is a part-level outage: the Jev part stops this tick and the row
  is not charged. An empty or blank model reply is content (charged), but only when every chain
  model answered blank. 5xx, 429, 408, timeouts, network errors and an exhausted chain are
  transport. Jev and the audit have **separate stop flags**, so a Jev outage never slows the audit
  and vice versa. `askJev` has a 60 s timeout. "skipped" means "not stamped by this call", and
  Task 5 counts completion only from DB state, never from outcomes.

**Task 5**
- Accepted: `lastError` in process memory (cleared on restart or a clean run); progress and ETA
  reflecting DB state, which counts every scorer; the one-test window in which a dev server built
  from this branch could act on a test's `running` switch (`afterEach` resets it, and no such
  server was running).

**Task 6**
- Accepted: the `triage.ts` ↔ `memory-doc-candidates.ts` import cycle. It is call-time only. The
  final wave may move `isRepoMirrorPath` to a leaf module.

**Task 7**
- Accepted: `scored=yes` means both scores are present, and `no` means either is missing. Score
  sorts are lowest first, disagreement largest gap first, unscored last. Exactly 0.4 counts as
  disagreeing (numeric cast + rounding).
- **`/review` shows the audit badge too.** The feed in `server/services/review.ts` adds
  `auditKeep`, `auditVerdict` and `auditReason` to memory-unreviewed items.
- Fix-round minors: `DISAGREE_THRESHOLD` and `MemorySort` moved to `shared/`; the vector-lane
  `console.warn` is silenced in the DB test (stubbed); a card in the `done` state offers
  **Re-run** (done → running) rather than a misleading Start.

**Task 8**
- The export's pure helpers live in `scripts/lib/memory-export.ts` with a unit test
  (`test/memory-export.test.ts`), following `scripts/lib/labelling.ts`. The plan named only
  `scripts/memory-export.ts`.
- The export includes archived memories (an `archived` column), plus `scope`, `audit_model`,
  `audit_prompt_version`, the failure counters, `jev_model` and a `disagreement` column, beyond
  the spec §7 list.

## Follow-ups (every deferred or parked item)

**Deferred to the final wave:**
- Task 4: a Jev 200 with an unparseable body is classed as transport. If that is deterministic
  for one row, it could stall the Jev part of every batch, the same shape as N1.
- Task 5: no live-dispatch test case for `memoryBackfill`; the `jevMissing` / `auditMissing`
  predicates are duplicated; no gate test for the pause-during-selection race.
- Task 6: hoist `isRepoMirrorPath` to a leaf module to break the import cycle.

**Deferred minors:**
- Task 2: the 0.7 confidence anchor sits below the 0.75 auto-review threshold. Auto-review is
  unchanged by design (D5), so a "durable but could change this year" memory now lands in
  `/review` instead of auto-reviewing.
- Task 3: no truncated-JSON test for `parseAudit`; a dead `belongs_in_doc` branch in the eval's
  `agreesWithLabel`.
- Task 7: the `/review` badge order and the tooltip wording changed; no unit test for the backfill
  card.

**Found at acceptance:**
- **Audit vs labels is 53%** (above). The audit is lenient on labelled-stale memories. Decide
  during the analysis whether to trust it, tune `audit-v1` (a new version re-audits everything),
  or lean on Jev's `transient`.
- **The ETA is optimistic early on.** It divides by the wall time since Start. Right after the
  first batch that is about 20 s, which gave "14 min" for 1,563 rows when the real figure is about
  3.3 h at 40 rows per 5 min. It converges after a few ticks.
- **Labels join on prod only.** The 45 label ids are prod ids. Run the export against prod
  (`DATABASE_URL` pointed at prod; it only reads) to get them.
- **Doc routing missed 1 of 4** eval rows (spec content came out as 3 memories). Watch
  `/input/` captures from `memory-enrichment` after deploy.

## Deploying (when merged)

1. Take a DB backup to `/root/db-backups` (gzipped). CD migrates **0064** (additive).
2. **The backfill switch stays off.** The `memory_backfill` setting is absent on prod, which reads
   as `off`. Do not set it in the deploy. Tony starts it from **Settings → Memory → Start**.
3. **What spends from deploy onward, without the switch:**
   - the `score-memories` cron (`5-59/15`, 50 rows per run) now **also audits** the unreviewed
     live rows it scores, so audit calls on the bulk chain start at deploy for that small set
     (the unreviewed queue; Jev had scored 98 queued rows when the spec was written);
   - new memories are Jev-scored and audited right after enrichment;
   - doc candidates from new extractions become `/input/` captures and go through triage.
4. **When Tony starts the backfill:** 40 memories every 5 minutes, about 480 an hour. For about
   2,450 prod memories expect **roughly 5 hours**. Watch the bulk chain and Jev load:
   - `activity_log` for the bulk chain (attempt-0 errors on every call mean a routing problem,
     not an outage);
   - Jev 429s;
   - the card's `lastError` and `skipped` counts.
   Pausing is safe at any time, and resuming loses nothing.
5. **Analysis follows, with Tony.** Once the card says `done`, run `pnpm memory:export` against
   prod and analyse it together: the audit vs Jev vs labels, the disagreement set, and the
   `belongs_in_doc` rows. Gating, archiving and cleanup are decided then (spec §10).
6. Smoke test: `/memories` shows the badges and filters; Settings → Memory loads with the switch
   "paused"; `/review` shows audit badges once the cron has audited the queue.

## Where cycle 78 starts

Run the final review wave on this branch, then merge and deploy (steps above). Tony starts the
backfill when he is ready to watch the load. After it reaches `done`, export and analyse with
him. The open questions: is the audit worth keeping given its 53% label agreement? Is Jev's
`transient` signal better on the full population? Which, if any, should gate auto-review or drive
archiving?
