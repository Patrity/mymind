---
title: Memory dual scoring — extract-v3, an LLM audit and Jev on every memory, a switch-gated backfill, doc routing, and an analysis export (cycle 77)
cycle: 77
date: 2026-10-01
status: deployed
branch: feat/memory-dual-scoring (worktree .claude/worktrees/memory-dual-scoring, base 9766132)
merged: true
deployed: true  # prod backfill ran 2026-10-01T20:30Z → 2026-10-02T01:00Z (done)
specs:
  - ../superpowers/specs/2026-10-01-memory-dual-scoring-design.md
plans:
  - ../superpowers/plans/2026-10-01-memory-dual-scoring.md
wiki:
  - ../wiki/memory.md
  - ../wiki/triage.md
migrations:
  - 0064 memories gains audit_keep, audit_verdict, audit_reason, audit_model, audit_prompt_version, audited_at, audit_failures, extract_prompt_version, jev_failures (additive)
migrations_run_on_prod: true  # 0064
backfill_switch_on_prod: done  # analysis + follow-on review gate: 2026-10-02-memory-review-gate.md
eval:
  audit_v1: { keep_rate: "11/11", stale_rejection: "12/12", doc_routing: "3/4", audit_vs_label: "24/45 (53%)", keep: "22/28", stale: "2/12", noise: "0/5", run: "Task 8, 2026-10-01" }
  audit_v2: { keep_rate: "11/11", stale_rejection: "12/12", doc_routing: "3/4 (1 unexpected)", audit_vs_label: "25/45 (56%)", keep: "17/28", stale: "8/12", noise: "0/5", run: "final fix wave, 2026-10-01, one real run" }
acceptance: passed  # one real runBackfillBatch({limit:40}) on dev: 40/40 audited, 26 new Jev scores (14 already had one), 0 content failures, 0 transport stops, 20.5 s
final_review: ready with fixes (0 C / 4 I / 6 M); fix wave done 2b7b5e7..HEAD — awaiting the controller's re-review
mymind_task: 992149a1-eed7-44f6-9c2f-a5a1ae5a3d7c
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
| final fix wave | 2b7b5e7, 4f22cbe, bab36ee, 556d244, 84d45c4, 89ef1fb + docs | `audit-v2`; audit 4xx poison rows charged; per-part backfill selection; ETA from the backfill's own runs; cron covers the last 7 days; doc-candidate slug suffix; recall tools drop the scores; export without `.env` (see [Final review fix wave](#final-review-fix-wave)) |

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
transient on wording such as "is being replaced", "currently unusable" or cycle numbers. The
final fix wave tuned the prompt once (`audit-v2`); the before/after is in
[Final review fix wave](#final-review-fix-wave).

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

### Final re-review residue (parked)
- N1: a backfill run can make up to 2 × limit calls of one part right after that part's outage ends (both parts run on every selected row lacking them). Bounded; docs corrected.
- N2: `list_reviews` (MCP) and `save_memory`'s dedupe return still carry the new score fields — recall paths (`search_memories`, `get_recent_memories`) and context assembly are clean.
- N3: the score-memories cron uses combined selection, so a Jev outage can stall its audit progress (the backfill uses per-part selection).
- audit-v2 trade-off: stale 8/12 (was 2/12) but keepers 17/28 (was 22/28) — errors now balanced; judge in the post-backfill analysis.

## Follow-ups (every deferred or parked item)

**Deferred to the final wave** (all triaged there; see [Final review fix wave](#final-review-fix-wave)):
- Task 4: a Jev 200 with an unparseable body is classed as transport. **Accepted, documented**
  (charging it would let a proxy serving an HTML 200 burn the cap on 120 rows in 3 ticks).
  Revisit if `lastError` shows it.
- Task 5: live-dispatch test case for `memoryBackfill` **done**; the duplicated predicates
  **exported once** from `memory-scoring`; no gate test for the pause-during-selection race
  (**accepted**: stubbing the setting between its two reads needs a module mock that would cover
  the whole file; the guard is 2 reviewed lines).
- Task 6: `isRepoMirrorPath` **moved** to the leaf `server/lib/documents/mirror.ts`.

**Deferred minors:**
- Task 2: the 0.7 confidence anchor sits below the 0.75 auto-review threshold. Auto-review is
  unchanged by design (D5), so a "durable but could change this year" memory now lands in
  `/review` instead of auto-reviewing.
- Task 3: a truncated-JSON test for `parseAudit` (taken in the final wave); the dead
  `belongs_in_doc` branch in the eval's `agreesWithLabel` is **gone**.
- Task 7: the `/review` badge order and the tooltip wording changed; no unit test for the backfill
  card.

**Found at acceptance:**
- **Audit vs labels: 53% (audit-v1) → 56% (audit-v2).** audit-v2 fixed the stale leniency
  (2/12 → 8/12) but over-calls `transient` on labelled keepers (22/28 → 17/28). Decide during the
  analysis whether to trust it or lean on Jev's `transient`. One tuning pass only, by ruling.
- ~~The ETA is optimistic early on~~ — fixed in the final wave (the backfill's own runs; null
  until 2 runs).
- **Labels join on prod only.** The 45 label ids are prod ids. Run the export against prod to get
  them: on the box `NUXT_DATABASE_URL=… pnpm memory:export` (`.env` is optional now), or from the
  laptop with `DATABASE_URL` pointed at prod. It only reads.
- **Doc routing missed 1 of 4** eval rows (spec content came out as 3 memories). Watch
  `/input/` captures from `memory-enrichment` after deploy.

## Final review fix wave

The whole-branch review (`9766132..a95452f`) said **ready with fixes: 0 Critical, 4 Important,
6 Minor**. The rulings (SDD ledger) and what was done:

| Item | Ruling | Done | Commit |
|---|---|---|---|
| **I1** audit poison row never charged | an audit request every chain model rejects with a 4xx = content failure (charged), mirroring Jev | `withFailover` records each attempt's HTTP `status`; `isRejectedRequestError` (every attempt blank or a 4xx other than 401/403/408/429) → content; 401/403/408/429, 5xx, no status, or any mixed chain → transport; Jev shares `isRequestRejectionStatus` | 4f22cbe |
| **I2** one part's outage freezes the other across batches | select per part: up to 40 needing the audit + up to 40 needing Jev, deduped into one scoring call | `selectUnscoredPerPart`; the backfill uses it; `done` still needs both empty | bab36ee |
| **I3** doc candidate dropped on a slug collision | suffix on collision, never silently dropped | on a unique violation, retry with `<slug>-<6 random chars>`; title = the text's first line (M6) | 556d244 |
| **I4** carried rulings | audit prompt tightening + ONE eval re-run; ETA from the backfill's own rate, null until ≥ 2 batches; roadmap row 76 → deployed | `audit-v2` (below); `etaFromRuns` over the last 6 runs' finished rows, cleared on a switch change; roadmap rows 76/77 updated | 2b7b5e7, bab36ee, docs |
| **M1** auto-reviewed new row never retried after `done` | the cron also covers rows created in the last 7 days regardless of review; the done card says "(N skipped)" | `orCreatedSince` on `selectUnscored`, `RECENT_MEMORY_DAYS = 7` | bab36ee |
| **M2** docs over-promise "through /review" | state that triage may auto-apply a task at ≥ 0.70 (accepted) | wiki memory/triage + Deploying step 3 | docs |
| **M3** score fields reach agent/MCP recall | strip them | `toRecallMemory` on `search_memories` / `get_recent_memories` | 84d45c4 |
| **M4** export dies without `.env` | load `.env` only if present | `--env-file-if-exists=.env`; `NUXT_DATABASE_URL` accepted | 89ef1fb |
| **M5** thin evidence on extraction yield | handover adds a post-deploy yield check | Deploying step 7 | docs |
| **M6** nits | per the review | capture title from the text; `scoreMemories` notes it queues every id | 556d244, bab36ee |
| Deferred-minor triage | 6 take, 4 accept | taken: T3 truncated-JSON test (6c44c63) + dead eval branch (2b7b5e7), T5 live-dispatch case + shared predicates (bab36ee), T6 `isRepoMirrorPath` → `server/lib/documents/mirror.ts` (556d244); T5 pause-race gate test **accepted** (needs a whole-file module mock; 2 reviewed lines). Accepted per the review: T2 0.7 anchor, T4 Jev 200-unparseable = transport, T7 badge order/tooltip, T7 card unit test | — |

### audit-v2 and the eval before/after

The 10 labelled-stale rows audit-v1 called `keep` were mostly **point-in-time state worded as a
rule**: pinned versions (`claude-code SDK v1.0.128`, `Drizzle ORM 0.36`, `@modelcontextprotocol/
server ^2.0.0`), the current stack ("runs Qwen3.8 Flash Next on an RTX Pro 6000"), a project's
data or schedule state (OPC `Trade` code coverage, "OPC logic changed from FF+32hrs to…"), and a
known defect (`sync_document` metadata). The audit justified each as "durable … useful", i.e. it
judged plausibility. audit-v2 adds two audit-only paragraphs (the shared extract-v3 criteria are
unchanged, so `EXTRACT_PROMPT_VERSION` stays): **judge durability, not plausibility**, and
**point-in-time state is `transient`** (project/plan/task/schedule/dataset state, known bugs,
pinned versions and the current stack), with general rules, stable invariants, gotchas about
external systems and facts about Tony kept. `AUDIT_PROMPT_VERSION = 'audit-v2'`, so the 40 dev
rows audited with v1 are re-selected by the backfill.

`pnpm memory:eval --audit-only` with audit-v1 just before the change reproduced Task 8 exactly.
Then ONE full `pnpm memory:eval` after it:

| | extraction keep | stale rejected | doc routing | audit agreement | label keep | label stale | label noise | keep vs not-keep |
|---|---|---|---|---|---|---|---|---|
| audit-v1 | 11/11 | 12/12 | 3/4, 0 unexpected | 24/45 (53%) | 22/28 | **2/12** | 0/5 | 27/45 |
| audit-v2 | 11/11 | 12/12 | 3/4, 1 unexpected | 25/45 (56%) | **17/28** | **8/12** | 0/5 | 30/45 |

Verdict spread, audit-v2: keep-labelled 17 keep / 11 transient; stale-labelled 8 transient /
4 keep; noise 5 transient. The extraction prompt did not change; the 1 unexpected doc candidate
(row 17, a pending-plan transcript) is run-to-run variance.

**Honest read:** v2 traded leniency for strictness. It now calls 11 of Tony's keepers
`transient`, mostly durable gotchas worded as bugs or tied to a version ("SitePro does not
support STRING_AGG", the vLLM fp8 KV-cache JIT issue, OPC pagination). The 4 stale rows it still
keeps read as durable constraints (portal handoff, Neo4j token store, Drive `.venv` pointer, OPC
`Trade` coverage). Per the ruling this was one pass, not a loop on 45 labels.

### Fix-wave gates and evidence

| Gate | Result |
|---|---|
| `pnpm test` | 302 files, **3084 passed / 1 skipped** |
| `pnpm test:db` (full) | 78 files, **858 passed** |
| `pnpm typecheck` | clean |
| `pnpm build` | green |

Dev DB, before → after (real counts): memories 1,662 → 1,662, live 1,603 → 1,603, live documents
4 → 4, settings 8 → 8, review_queue 44 → 44, live tasks 8 → 8; raw `tasks` 5,892 → 5,906 (the 14
soft-deleted triage fixtures every full `test:db` creates, as in Task 8). The `memory_backfill`
setting was absent before and is absent after. Rows audited with `audit-v1`: 40 (re-audited once
the backfill runs). The eval's only DB writes are `activity_log` rows.

Every behaviour fix has a test that went red when the fix was reverted (one file at a time, after
the commit, restored with `git checkout --` and `git diff --quiet`): the I1 classifier (5 tests),
the attempt `status` capture, per-part selection (3), the ETA window formula (2), the ETA reset on
a switch change, the M1 7-day window, the I3 collision retry, the M6 title, the M3 strip (2), the
M4 env flag, the audit-v2 prompt and version, the `memoryBackfill` live dispatch, and the
truncated-JSON parse. One equivalent mutant: `runs.length < 2` → `< 1` stays green, because one
run contributes no finished rows to the rate anyway (the guard is kept for readability).

**Not browser-validated:** the done card's "(N skipped)" suffix is a one-line template change.
Showing it on dev needs the switch set to `done` and a capped row, i.e. writes to real dev rows.
Typecheck and build cover it; check it at the smoke test after the prod backfill finishes.

## Deploying (when merged)

1. Check `df -h` first (the box recently filled its disk), then take a DB backup to
   `/root/db-backups` (gzipped). CD migrates **0064** (additive).
2. **The backfill switch stays off.** The `memory_backfill` setting is absent on prod, which reads
   as `off`. Do not set it in the deploy. Tony starts it from **Settings → Memory → Start**.
3. **What spends from deploy onward, without the switch:**
   - the `score-memories` cron (`5-59/15`, 50 rows per run) now **also audits** the unreviewed
     live rows it scores, so audit calls on the bulk chain start at deploy for that small set
     (the unreviewed queue; Jev had scored 98 queued rows when the spec was written);
   - the same cron also covers rows **created in the last 7 days** whatever their review state
     (retries for new rows whose fire-and-forget scoring hit an outage);
   - new memories are Jev-scored and audited right after enrichment;
   - doc candidates from new extractions become `/input/` captures and go through triage. Note,
     memory and append are `/review` proposals, but **triage auto-applies a task at ≥ 0.70**, so a
     doc candidate can become a live task without review (existing triage behaviour, accepted).
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
7. **Post-deploy extraction-yield watch (final review M5).** extract-v3's eval set is 22 short
   synthetic transcripts, so watch the real thing for a week. Compare, for rows with
   `extract_prompt_version = 'extract-v3'` against the 7 days before deploy: memories per enriched
   session, and the share of rows at confidence ≥ 0.75 (auto-reviewed). Investigate if yield falls
   by more than half or the 0.6–0.75 share jumps (durable facts slipping under auto-review would
   hide them from recall, which defaults to reviewed only).

## Where cycle 78 starts

> **Resolved 2026-10-02** — the backfill ran, the analysis is in
> [`2026-10-02-memory-review-gate.md`](2026-10-02-memory-review-gate.md), and its outcome (a
> both-scorers review gate) shipped. The text below is the pre-analysis state.

The final review fix wave is done; after the controller's re-review, merge and deploy (steps
above). Tony starts the
backfill when he is ready to watch the load. After it reaches `done`, export and analyse with
him. The open questions: is the audit worth keeping given its 56% label agreement (and its
over-calling of `transient` on durable gotchas)? Is Jev's
`transient` signal better on the full population? Which, if any, should gate auto-review or drive
archiving?
