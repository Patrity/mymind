---
title: Memory System
status: shipped  # cycle 77 dual scoring is built on feat/memory-dual-scoring; not merged/deployed (migration 0064 dev only)
cycle: 77
updated: 2026-10-01
mymind_id: c17a75f7-52f5-4024-8e2d-c0e173245096
mymind_hash: d4ea96997da904ab23477600de75a585a82d29a5a5fac0cc1b515bda45aea925
---

# Memory System

Reimplements the bridget memory service in TS: ingest AI-session transcripts, enrich into durable memories, search semantically. Nothing auto-trusted — enrichment memories are `unreviewed` until the human marks them reviewed.

## Data model
- `memories` (`server/db/schema/memories.ts`): `scope` (user|agent|world), `content`, `tags[]`, `source`, `embedding halfvec(2560)`, `content_hash` (sha256), `confidence`, `evidence` jsonb, `project`, `project_id` (FK → projects; **null = global / agnostic**, cycle 23), `source_date` (last-observed, = source session `started_at`, cycle 23), `session_id`, `superseded_by` (→ the memory that replaced this one, cycle 13), `enriched_at`, `reviewed_at`, `created/updated/archived_at`, plus **cycle 70**: `applicability` (`global`|`project`, default `project`), `resident` (boolean, DB CHECK `resident => applicability='global'`), `retrieval_count`, `last_retrieved_at`; plus **cycle 72**: `jev_score` (real, Jev's second opinion — see [Jev scoring](#jev-scoring-a-second-opinion-cycle-72)), `jev_answers` (jsonb, the raw Noul answers), `jev_scored_at`, `jev_model` (the version that *answered*); plus **cycle 77** (migration 0064, see [Dual scoring](#dual-scoring--extract-v3-the-llm-audit-and-the-backfill-cycle-77)): `jev_failures`, `audit_keep` (0–1), `audit_verdict`, `audit_reason` (≤ 200 chars), `audit_model` (the model that *answered*), `audit_prompt_version`, `audited_at`, `audit_failures`, `extract_prompt_version` (stamped on new rows, null before cycle 77). Indexes: scope, tags GIN, content trigram GIN, embedding HNSW cosine, partial-unique content_hash WHERE archived_at IS NULL. `evidence` entries (cycle 13) are `{ sessionId, msgIds, quote, reasoning, mergedAt }`.
- `memory_relations` (cycle 13, `memory-relations.ts`): `from_id`→`to_id`, `type` (supersedes|contradicts|duplicate-of), `confidence`, `status` (active|resolved), `reason`. The lineage/conflict graph; unique edge `(from,to,type)`.
- `sessions` (source, external_id unique, project, cwd, title, summary, message_count, started_at, last_active, metadata) + `messages` (session_id, role, content, external_uuid unique-per-session) + `mem_enrichment_state` (enrichment progress; **cycle 70** re-keyed `(source_kind, source_id)` where `source_kind` is `session`|`conversation`).

## Service — `server/services/memory.ts` (+ `memory-dedup.ts`)
- `createMemory` embeds content, then **two-stage dedup** (`dedupDecision`): exact `content_hash` → skip; semantic cosine ≥ 0.85 in same scope/project → merge evidence; else insert.
- `searchMemories(q, {scope,project,tags,limit,reviewed})` — hybrid trigram + vector cosine RRF (same pattern as `searchDocs`), trigram fallback. `reviewed` (cycle 51): `true` → reviewed only, `false` → unreviewed only, `undefined` → no filter; built by the shared `reviewedCondition(reviewed?)` that `listMemories` also uses.
- `listMemories`, `getMemory`, `updateMemory` (re-embed on content change), `reviewMemory`, `archiveMemory`, `countUnreviewedMemories`.

## Two inlets into memory

Memories enter via exactly two paths, both going through `createMemory` (shared dedup via `dedupDecision` + `buildDedupCandidates`):

1. **Enrichment loop** (`enrich-memories` cron → `server/services/memory-enrich.ts`): distills concise, **confidence-scored**, **session-linked** (`sessionId` + evidence) memories from session transcripts. Auto-reviews when `confidence >= memoryAutoReviewThreshold` (~0.75). This is the primary source of agent-scoped memories.

2. **Direct `save_memory`** (MCP tool / `POST /api/memories`): saves raw content. Accepts an optional **`confidence`** (0–1) — a value ≥ 0.75 auto-reviews the memory; `null` (omitted) leaves it for manual review. `shouldAutoReview(confidence, threshold)` returns `false` for `null` — no-confidence saves always require human review. The tool description nudges callers toward ONE concise durable sentence; architecture detail belongs in handovers/wiki, not memory. Manual saves created via `POST /api/memories` (cycle 10) set `source: 'manual', reviewed: true` and skip the unreviewed state entirely.

## Applicability vs provenance (cycle 70)

`project` records where a fact was **learned**, not where it applies — enrichment runs per session, a
session has a project, and the memory inherits it. Before cycle 70 that meant 69 of 74 user-scope
memories sat filed under whichever project happened to reveal them.

- **`applicability`** — `global` means the fact travels across every project; `project` binds it to
  its provenance. Retrieval is `applicability = 'global' OR project = X` in both `searchMemories` and
  `listMemories`. `project: null` still means "memories with no project at all" — a different
  question, deliberately not folded in.
- **`resident`** — a much smaller set: facts injected into **every** agent turn, not merely
  retrievable. `resident` implies `global` (enforced by a DB CHECK). `listResidentMemories()` also
  requires `reviewed_at` — an unreviewed memory reaching every prompt is the cycle-51 hole, and the
  resident tier has no query gating it.
- **`retrieval_count` / `last_retrieved_at`** — written batched by the assembler (one grouped UPDATE
  per turn), intended to let the resident tier nominate itself from measured cross-project usage
  rather than a model's judgment of importance.

**Current reality (prod, 2026-09-26):** the applicability backfill
(`scripts/backfill-applicability.ts`) has been run against production — 2,301 live project-tagged
memories classified, **27 set to `global`** (1.2%), 104 confirmed `project`, and 2,170 left at the
default because the classifier was uncertain. The promoted set is genuinely cross-project (`Tony
works for NLS`, Gulf Coast insurance, the git-worktree and PowerShell gotchas).

1.2% is a thin yield and the script's own Ruling 18 predicted it: the noul distribution is too
compressed to gate confidently. Real global promotion is meant to come from the
**retrieval-count** path — a memory measurably reused across projects — which needs the `resident`
writer. **Nothing writes `resident` yet**, so `listResidentMemories()` still returns `[]` in
production; that path needs `/review` approve handlers that do not exist. The `global` tier is now
lightly populated; the `resident` tier is empty.

## Enrichment sources (cycle 70)

Enrichment reads **both** Claude Code sessions and Bridget conversations. Before cycle 70 it read
sessions only, so talking to Bridget produced no memories at all. `enrichConversations` mirrors the
session path's thresholds (≥5 new messages, ~1h idle, 24h error backoff) and reuses
`extractMemoriesFromTranscript` — one prompt, not two.

**Known gap:** conversation enrichment calls `createMemory` directly rather than
`resolveEnrichedMemory`, so Bridget-derived memories get no dedup/supersede/contradict detection and
land `project: null`.

## Ingestion — hooks (`server/api/hooks/cc/*`, `server/services/sessions.ts`)
- `POST /api/hooks/cc/[event]` upserts a session (liveness/metadata). `POST /api/hooks/cc/transcript` parses CC JSONL lines (tolerant: user/assistant text parts) → idempotent `messages`. Bearer-token auth.

## Enrichment — `server/services/memory-enrich.ts` + `enrich-memories` task (*/15)
Selects sessions with ≥4 messages and new content since last run; assembles a transcript; one model call with a strict atomic-memory JSON prompt (since cycle 77: `extractV3`, the `bulk` chain — see [extract-v3](#extract-v3--the-extraction-prompt)); `parseMemories` (tolerant); each candidate → `createMemory` (tagged `enrichment`,`unreviewed`); records `mem_enrichment_state`. Manual: `POST /api/admin/memory-enrich-run`.

**Cycle 7 — review threshold + relevance:** `createMemory` auto-reviews when `confidence >= memoryAutoReviewThreshold` (default 0.75) — sets `reviewed_at` and strips the `unreviewed` tag; `reviewMemory` also strips `unreviewed`. Only low-confidence memories need human review. `searchMemories` attaches a `relevance` score (rank-based `1/(1+rank)`, or the optional Qwen3-Reranker at `:8883` behind `AI_RERANK_BASE_URL`, OFF by default).

**Cycle 10:** a manual **Add memory** modal (`POST /api/memories` → `createMemory({...,source:'manual',reviewed:true})`, so it's not unreviewed) + a `USelectMenu` tag filter.

**Cycle 13 — enrichment tuning + memory intelligence.** The enrichment loop was tuned and now persists via `resolveEnrichedMemory` (`memory-resolve.ts`) instead of the plain `createMemory`:
- **Tuned selector:** real-message floor ≥4 (user/assistant, content-or-thinking, excludes sidechain + `system_prompt`), a 1h grace period (don't enrich still-active sessions), growth ≥5 since last run, error-retry after 24h, and excludes only KNOWN-inactive projects (`project not in (select slug from projects where active=false)` — null/unknown projects still enrich). Bridget-quality prompt: atomic durable facts, scope guidance (`agent` most common), confidence bands (drop <0.3), and per-memory `evidence_msg_ids` + verbatim `quote` + `reasoning`. Memories inherit the session's `project`.
- **Relationship-judge** (`memory-judge.ts`): for a new candidate's cosine-near existing memories (same scope/project bucket), `chat('reasoning')` classifies each as duplicate / refines / contradicts / unrelated. Runs in **enrichment only** — manual MCP/REST saves keep the cheap `createMemory` dedup.
- **Resolution** (`resolveEnrichedMemory`): exact-hash → merge evidence; else judge → **duplicate** (merge) · **refines** → `supersede` / `review-supersede` · **contradicts** → `contradict` / `review-contradict` · else insert fresh. See the ladder below for the exact branch conditions. Conflicts ride the existing `review_queue`; `/review` resolves them (accept = archive the loser + mark the relation `resolved`; keep-both = resolve relation only).

### The resolution ladder — which action archives, and what gates it (cycle 51)

`chooseResolution(verdicts, { threshold, scope, challengerSessions, sessionsFor })`
(`server/services/memory-resolve.ts`) is pure and picks exactly one action, in this order:

| Action | Reached when | Writes | Archives the incumbent? |
|---|---|---|---|
| `duplicate` | a `duplicate` verdict ≥ 0.6 | evidence merge onto the existing row | no |
| `supersede` | `refines`, **not gated**, `confidence >= threshold` (~0.75) | new row + `memory_relations(type='supersedes')` + `archived_at`/`superseded_by` on the old row | **YES — this is the only action that does** |
| `review-supersede` | `refines`, **gated** (any confidence) OR `confidence < threshold` | new row + `supersedes` relation + a `memory-supersede` `review_queue` row | no — both stay live |
| `contradict` | `contradicts`, **not gated** | new row + `contradicts` relation + a `memory-contradict` `review_queue` row | no |
| `review-contradict` | `contradicts`, **gated** | identical writes to `contradict` | no |
| `insert` | nothing else matched | fresh row | n/a |

**The gate** (`gatedByCorroboration(existingId)`) applies to the `refines` and `contradicts`
branches only — never to `duplicate` or `insert` — and is true when either:

- **`scope === 'user'`.** Identity/preference claims are never auto-resolved: a wrong
  resolution there is self-reinforcing (the bad memory shapes later sessions, which then
  corroborate it).
- **the incumbent is out-corroborated**: `sessionsFor(existingId) >= 2 && challengerSessions <
  sessionsFor(existingId)`. `countEvidenceSessions()` counts distinct `sessionId`s in a
  memory's `evidence` jsonb (already appended per derivation by `mergeEvidence` — no schema
  change was needed). High confidence from ONE exploratory session is not evidence.

On the `refines` path the gate is checked **before** the confidence comparison, so a
user-scope or out-corroborated refinement routes to review **even at confidence 1.0** — that
ordering is the whole point and is mutation-tested. `sessionsFor` is a lookup by id rather
than a pre-computed number because the refines target and the top contradiction are routinely
different memories, so the caller cannot know which row the gate will judge; it builds a
`Map<id, count>` over the near-neighbour rows it already selected.

> Cycle 51 correction: the earlier framing that a contradiction could "silently archive" a
> memory was wrong. `contradict` has **never** archived anything — it has always inserted a
> relation + a review row. `review-contradict` is byte-identical in effect. The branch that
> archives is `supersede`, which is why the gate now covers it.

## Jev scoring — a second opinion (cycle 72)

`confidence` is the enrichment writer grading its own work. **Jev** (TypeSafe System One) is an
independent read of the same text, stored beside it and **oriented the same way — higher means
more likely worth keeping** — so a gap between the two is the signal worth looking at.

**It sorts the review queue. It does not decide anything.** That limit is measured. Against the
28 hand labels in `scripts/data/memory-labels-2026-09-22.jsonl`:

| Signal | Predicts | AUC | 95% CI |
|---|---|---|---|
| `transient` ("a point-in-time snapshot") | noise | **0.81** | [0.62, 0.96] — the only significant one |
| `rederivable` | noise | 0.62 | [0.19, 0.89] |
| `value` (holistic "how valuable is this") | noise | **0.27** | **anti-correlated** |

The pattern: **observable** questions carry signal, the **taste** question does not — it asks Jev
to guess Tony's judgement instead of reading the text. It is not asked at all, and
`test/memory-jev-score.test.ts` fails if anyone re-adds it. Ordering needs only to beat random
(0.81 clears that); a drop threshold needs calibration, and with 4 noise examples every cutoff
priced out **at or below the 43% base rate** — it would discard more keepers than junk.

- `server/lib/memory/jev-score.ts` — the four pinned questions + `jevKeepScore` (pure; weighting
  dominated by `transient`) + `compareByJev` (worst-first; **unscored sorts last**, because
  unknown is not bad; newest-first on a tie).
- `server/lib/ai/jev.ts` — `jevConfig()` resolves through `resolveChain('jev')`, `askJev()` POSTs
  `{state, model, questions}` to `${baseURL}/systemone` and retries only on 429.
- `server/services/memory-jev.ts` — `runJevScoring({limit})` targets live rows missing a part that
  are **unreviewed or created in the last 7 days** (`RECENT_MEMORY_DAYS`, final review M1). Since cycle 77 it goes through the shared scoring path
  (`server/services/memory-scoring.ts`), so the same run also **audits** those rows, and failures
  are counted per row (see [Failure handling](#failure-handling)).
- `server/tasks/score-memories.ts` — cron `5-59/15`, i.e. *after* `enrich-memories` on the quarter
  hour rather than racing it, 50 rows per run. With no `jev` model assigned, only the audit runs.

The **raw answers are stored** so a better weighting, once there are more labels, is a recompute
rather than thousands of API calls. `jev_model` records the version that **answered** — the config
requests `jev-latest` and the API echoes back the resolved version — so a future calibration can
segment by version instead of assuming one.

**Known limit:** Jev is good at spotting *transient* junk and has no measured ability to spot a
durable-sounding fact that is simply wrong or redundant. Those still sit mid-pack.

## Dual scoring — extract-v3, the LLM audit and the backfill (cycle 77)

Built on `feat/memory-dual-scoring`; not merged or deployed (migration 0064 on dev only).

On prod (2026-10-01), 94% of enrichment memories were extracted at confidence ≥ 0.75 and
auto-reviewed, so the extraction confidence barely discriminates, and Jev had only scored the 98
queued memories. Cycle 77 is **measurement, not policy**: a better extraction prompt, two current
scores on every memory, a backfill, and an export for analysis. **Nothing acts on the scores.**
They do not archive, do not change auto-review (still the extraction confidence threshold), and
never edit content. Gating is decided after the prod backfill is analysed.

### Three numbers per memory

| Column | What it is | Written by |
|---|---|---|
| `confidence` | the extractor grading its own output when it wrote the row; historical ("at extraction") | enrichment |
| `jev_score` (+ `jev_answers`) | Jev's Noul read (see above) | the scoring path |
| `audit_keep` + `audit_verdict` + `audit_reason` | the LLM audit: would this memory pass the extract-v3 criteria **today**, and how durable is it? | the scoring path |

All three point the same way: higher means keep. **Disagreement** is `|audit_keep − jev_score|`.
It is computed in SQL with a numeric cast (float4 arithmetic put 0.7 − 0.3 just below 0.4) and is
null unless both scores exist. A memory with only one score is never counted as disagreeing.
`DISAGREE_THRESHOLD = 0.4` and the sort names live once in `shared/`.

### extract-v3 — the extraction prompt

`server/lib/memory/extract-v3.ts`: `EXTRACT_PROMPT_VERSION = 'extract-v3'`, `EXTRACT_V3_CRITERIA`
(the single definition of "a good memory", shared with the audit), `EXTRACT_SYSTEM_PROMPT`,
`extractV3(transcript)`. It makes one `chat('bulk', …)` call at temperature 0.2 with maxTokens
1600. The `reasoning` alias emits think blocks that `chat()` rejects, so the call uses `bulk`.

- **Reject, time-sensitive:** pending or planned work, in-progress state, versions, counts,
  prices and dates expected to change, "currently/now/today" facts, TODOs. **Judge the fact, not
  its wording:** "from now on, always X" preferences and "we decided X because Y" decisions are
  durable, restated in timeless present tense.
- **Reject, belongs in a document:** architecture detail, spec or handover content, multi-step
  how-tos. These are emitted as `doc_candidates` (below).
- **Require:** a single, self-contained fact that is useful in six months. Stable host and service
  locations are allowed; source-file, temp and worktree paths, line numbers and SHAs are not.
- **Confidence anchors:** 0.9 stable fact; 0.7 durable but could change this year; 0.5 likely to
  change within weeks; below 0.6 do not extract (the parser floor). The 0.7 anchor sits **below**
  the 0.75 auto-review threshold. That is deliberate: auto-review is unchanged this cycle.
- **Output:** `{ memories: [...], doc_candidates: [{ text, project?, targetDocHint? }] }`.
  `parseExtractV3` is tolerant: missing or malformed candidates give `[]`, textless ones are
  dropped, and at most 5 are kept. `extractBalanced` is string-aware, so a `}` inside a JSON
  string no longer cuts the object short. That also fixed `parseMemories`.
- New rows are stamped `extract_prompt_version = 'extract-v3'` on insert only. Merge and duplicate
  paths leave the existing row alone.

### The audit

Same file: `AUDIT_PROMPT_VERSION = 'audit-v2'`, `AUDIT_VERDICTS` = `keep | transient | redundant |
wrong_scope | belongs_in_doc`, and `AUDIT_SYSTEM_PROMPT`, which restates `EXTRACT_V3_CRITERIA`
verbatim and adds two audit-only rules (audit-v2, final review I4): **judge durability, not
plausibility** (true, specific or useful is not durable), and **point-in-time state is
`transient`**: the state of a project, plan, task, schedule or dataset, a known bug or defect,
pinned versions and the current stack. A general rule, stable invariant, non-obvious gotcha about
an external system or fact about Tony stays `keep` even when it names a version or project in
passing. `audit-v1` rows are re-selected and re-audited. `auditMemory(m)` sends the memory's content, scope, project and age in days on the
`bulk` chain (temperature 0, maxTokens 300) through `chatWithModel`, which also returns the model
that **answered**, stored as `audit_model`. `parseAudit` clamps `keep` to [0, 1]. A missing
`keep` or an unknown verdict is a failure. `reason` is optional, defaults to `''` and is trimmed
to 200 chars.

### The scoring path — `server/services/memory-scoring.ts`

One function scores a memory, used by all three callers: enrichment (new rows, fire-and-forget),
the `score-memories` cron, and the backfill. It only writes the `jev_*` and `audit_*` columns.

- **Each part is independent.** A part runs while it is missing (`jev_scored_at` null /
  `audit_prompt_version` ≠ `audit-v2`) and has fewer than `MAX_FAILURES = 3` failures. A new
  audit prompt version therefore re-selects every row for re-audit.
- **Process-wide limiters:** Jev concurrency 6 and audit concurrency 2, shared by every caller.
  `askJev` has a 60 s timeout.
- **Stamps are guarded** ("still missing", `.returning()`), so when two callers race on one row
  the first writer wins and the second write is a no-op. Both may still spend one call. One
  `memory` live event is published per stamped row.
- `selectUnscored(limit, { jevConfigured, unreviewedOnly?, orCreatedSince?, part?, onlyIds? })`:
  live rows only (`archived_at is null`, so a row archived mid-backfill drops out), unreviewed
  first, then oldest. With Jev unassigned, a missing Jev score does not keep a row selected.
  `part` limits it to rows missing that one part. `orCreatedSince` (with `unreviewedOnly`) also
  takes rows created since then, whatever their review state.
- `selectUnscoredPerPart(limit, opts)`: up to `limit` rows needing the audit **plus** up to
  `limit` needing Jev, deduped (final review I2). One combined selection used to re-pick the
  same rows during a one-part outage (they still needed the down part), so the other part made no
  progress across batches. Empty only when both parts are.
- The predicates `jevMissing` / `auditMissing` / `needsJev` / `needsAudit` are exported and reused
  by `backfillProgress`, so `remaining` cannot drift from selection.

#### Failure handling

| Kind | Examples | Effect |
|---|---|---|
| **Content** (this row) | audit reply unparsable or invalid; every chain model answered blank **or refused the request with a 4xx other than 401/403/408/429** (`isRejectedRequestError`; `withFailover` records each attempt's HTTP `status`, final review I1); Jev 200 with no usable answers; Jev 4xx other than 401/403/408/429 | the row's `audit_failures` / `jev_failures` goes up; after 3 that part is skipped for good; the batch carries on |
| **Transport** (infrastructure) | network error, timeout, 408/429/5xx, a failover chain where any member failed that way (or with no recorded status); Jev 401/403 (a bad key is an outage of the Jev part) | the row is **not** charged; that part stops for the rest of the batch (circuit breaker), the other part keeps going; the rows are retried next run |

Nothing throws out of a batch. **Known gap:** a Jev 200 with an unparseable body is classed as
transport, so a row that deterministically gets one would stall the Jev part of each batch.

### Who scores what

| Caller | Rows | When |
|---|---|---|
| enrichment | the memories it just inserted | right after creation, fire-and-forget |
| `score-memories` cron | live rows missing a part that are **unreviewed or created in the last 7 days**, 50 per run | `5-59/15`, always on. Since cycle 77 it **also audits** them, so audit spend starts at deploy for that small set. The 7-day window retries an auto-reviewed new row whose fire-and-forget scoring hit an outage, even after the backfill is `done` |
| `memory-backfill` task | **all** live rows (reviewed included) missing a part, up to 40 per part per run | `*/5`, only while the switch is `running` |

### The backfill

`server/services/memory-backfill.ts`, `server/tasks/memory-backfill.ts`, setting
`memory_backfill` = `{ state: 'off' | 'running' | 'done', startedAt, finishedAt }`
(`server/lib/memory/backfill-setting.ts`; a missing or malformed value reads as `off`).

- `runBackfillBatch({ limit = 40 })` does nothing unless `running`. It selects per part
  (`selectUnscoredPerPart`: up to 40 needing the audit and up to 40 needing Jev, so 40–80 rows;
  both parts run on every selected row that lacks them, so up to 80 calls of one kind right after
  that part's outage ends — bounded at 2 × limit) and scores them in one call. When selection comes back empty it flips the switch to `done`, after re-reading the
  state so a pause made during selection never becomes `done`. There is no cursor: a crash, restart
  or pause loses nothing.
- `setBackfillSwitch('running' | 'off')`: a repeat of the current state is a no-op, so pressing
  Start again does not re-stamp `startedAt` or reset the ETA. A real change clears the recorded runs.
- `backfillProgress()`: one aggregate over live rows: `total`, `jevDone`, `auditDone`
  (`audit-v2`), `skipped` (a missing part at the failure cap), `remaining` (the selection rule),
  `etaMinutes` and `lastError`. **ETA** (`etaFromRuns`, final review I4): the backfill's own
  recent pace. Each run records how many of its rows it finished (no longer needing either part);
  the rate is the rows finished by runs 2..n of the last 6 over the time since run 1. It is null
  until 2 runs, and only shown while `running`. Rows other scorers finish never feed it. The runs
  and `lastError` live in process memory: a restart (or, for the runs, a switch change) clears them.
  `skipped` and `remaining` can overlap (Jev capped but audit pending).
- API: `GET /api/memories/backfill` (progress) and `PUT /api/memories/backfill { state: 'running' |
  'off' }`. Both are session-only. `done` cannot be PUT. A change publishes `memoryBackfill`.
- **Settings → Memory** (`app/pages/settings/memory.vue`, `MemoryBackfillCard.vue`): state badge
  (`off` shows as "paused"), progress bar, Jev and audit counts, remaining, skipped, ETA, last
  error, and Start / Pause (Re-run when done). When done it reads "All memories scored", plus
  "(N skipped)" when rows hit the failure cap.
- **Throughput:** 40 rows every 5 minutes, about 480 an hour. One dev batch of 40 took 20.5 s.
  About 2,450 prod memories take roughly 5 hours. The ETA appears from the second run (about
  5 minutes after Start).

### `/memories`

`<MemoryScoreBadges>` (`app/components/memory/ScoreBadges.vue`, helpers in
`app/lib/memory/scores.ts`) shows the audit percent with a verdict badge, Jev, a "disagree" badge
when both scores exist and the gap is ≥ 0.4, and the extraction confidence as "at extraction".
Each has a tooltip (verdict + reason; Jev's raw answers). Missing scores show as dimmed "audit —"
and "Jev —". `/review` uses the same component.

`GET /api/memories` gains `verdict` (one of the five), `scored=yes|no` (yes = both scores; no =
either missing), `disagree=1` and `sort=created|audit|jev|disagreement`. Score sorts are lowest
first, disagreement largest first, unscored last, newest first on a tie. Search takes the
filters but keeps relevance order (the sort control is disabled while searching). The page adds
a verdict select (sentinel `all`), a scored select (sentinel `any`), a "Disagree only" switch and
a sort select.

### Doc candidates → triage

`server/services/memory-doc-candidates.ts` `fileDocCandidate(candidate, { sessionId |
conversationId })` files each `doc_candidate` as an `/input/` capture through `createDoc` (the
`quick_capture` path) and fires `triageCapture` on it. The body is the text plus `— From memory
extraction (project: <slug or "(no project)">; suggested doc: <hint or "none">)`; the title is the
text's first line (≤ 80 chars). The slug comes from the hint; hints are generic ("handover") and
an untriaged capture stays live in `/input/`, so on a path collision the slug gets a 6-char random
suffix and the capture is filed anyway (final review I3). Triage then treats it like any capture:
note, memory and append go to `/review` as proposals (their thresholds are 1.1), but **a task is
auto-applied at ≥ 0.70** (`triageThresholds.task`), the existing triage behaviour, accepted for
doc candidates (final review M2). **No document is written directly.** An append into a
repo-mirrored doc (`/projects/<slug>/wiki/` or `/handovers/`, `isRepoMirrorPath` in
`server/lib/documents/mirror.ts`) is refused and becomes a note; see [triage.md](triage.md). Failures are logged and never block enrichment. The backfill only
*labels* old memories `belongs_in_doc`; it moves nothing.

### Measurement tools

- **`pnpm memory:eval`** (`scripts/memory-eval.ts`): real calls, run by hand. Part 1 runs
  `extractV3` over the 22 transcripts in `scripts/data/memory-eval-v3.jsonl` (committed,
  synthetic). The bar is ≥ 90% of durable facts kept and ≥ 80% of stale facts rejected. A
  pure-stale row counts as rejected only if it yields zero memories. Part 2 runs the audit over
  the 45 labelled rows and reports agreement under keep↔keep, stale↔transient,
  noise↔redundant|wrong_scope, per label with the verdict spread. `--audit-only` skips part 1.

  | Run (2026-10-01) | extraction keep | stale rejected | doc routing | audit agreement | keep | stale | noise |
  |---|---|---|---|---|---|---|---|
  | `audit-v1` (Task 8; re-read before tuning gave identical numbers) | 11/11 | 12/12 | 3/4, 0 unexpected | 24/45 (53%) | 22/28 | 2/12 | 0/5 |
  | `audit-v2` (one tuning pass, final review I4) | 11/11 | 12/12 | 3/4, 1 unexpected | 25/45 (56%) | 17/28 | 8/12 | 0/5 |

  audit-v2 fixed the leniency on stale (6 more stale rows called `transient`) but now over-calls
  `transient` on 11 labelled-keep rows, mostly durable gotchas worded as bugs or tied to a
  version ("SitePro does not support STRING_AGG", the vLLM fp8 KV-cache issue). Keep vs not-keep
  agreement went 27/45 → 30/45. Noise is still 0/5: the audit calls it `transient`, never
  `redundant`/`wrong_scope`, which it cannot judge from one memory alone. This was one pass by
  ruling, not a loop on the labels. Read the verdicts with both biases in mind.
- **`pnpm memory:export`** (`scripts/memory-export.ts`, helpers `scripts/lib/memory-export.ts`):
  read-only, one `SELECT` in a read-only transaction. It writes
  `scripts/data/memory-scores-<date>.{csv,jsonl}` (gitignored), one row per memory, archived
  rows included. Columns: id, content, scope, project, created_at, extraction confidence and
  prompt version, audit keep/verdict/reason/model/prompt version/failures, Jev keep/raw
  answers/model/failures, disagreement, archived, reviewed, and Tony's labels from every
  `scripts/data/memory-labels-*.jsonl`, joined by id (a later file or line wins). The labels are
  prod ids, so they join only against prod. `.env` is loaded only if present
  (`--env-file-if-exists`) and `NUXT_DATABASE_URL` is accepted, so on the native prod box
  `NUXT_DATABASE_URL=… pnpm memory:export` works (or point `DATABASE_URL` at prod from the laptop).

## Review surface — `app/pages/review.vue` (cycle 72)

Both card kinds show a **`📁 project` badge**; for a conflict it is resolved server-side from the
NEW memory in `listReviewFeed` (the row itself has no project). Two memories can read as flatly
contradictory and both be correct in different projects, so it is the first thing needed to judge
one.

- **Unreviewed memories** show `confidence`, `% Jev` and (cycle 77) the **audit** percent + verdict
  badge side by side, through the shared `<MemoryScoreBadges>` component, and have **two** exits:
  *Mark reviewed* and *Discard*. Discard archives (never deletes) and the archive response's undo
  token drives an **Undo** toast. This matters because `assembleContext` searches with
  `reviewed: true` — marking reviewed is exactly what lets Bridget see a memory, so with only one
  exit the queue could promote junk into her context but never shed it.
- **Conflicts** resolve four ways via `POST /api/review/[id]/resolve`: `keep-both`, `archive-old`,
  `archive-new`, `archive-both`. `archivalPlan` (`server/lib/review/conflict-resolution.ts`) is a
  pure, tested function deciding which rows to archive — inverting it would silently archive the
  memory the user chose to keep. Every branch archives; nothing here deletes.

**Deciding from an agent session (cycle 76, built on `feat/bridget-self-improvement`).** The
choices each item offers come from ONE registry, `shared/review/choices.ts` `reviewChoices`. The
page renders its buttons from it:
- unreviewed memories: `approve` "Mark reviewed" and `reject` "Discard";
- conflicts: the four resolutions above;
- other kinds: approve and reject.

The approve, reject and resolve routes are thin wrappers over
`server/services/review-decisions.ts` `decideReview`. Bridget's **`list_reviews`** (read, also
on MCP) lists pending items with their `choices`. **`decide_review`** calls the same service, so
undo tokens and live events are identical. It is dangerous and **confirmed by Tony on every
call** (app card or iMessage 👍). It is never allowlistable, refused in headless runs, and absent
from MCP. See [self-improvement.md](self-improvement.md#review-and-the-review-tools).

⚠️ `POST /api/agent/undo` takes `{ token }`, **not** `{ undoToken }` (zod rejects the latter with a
500). The archive response's field is named `undoToken`, so the asymmetry is easy to get wrong.

## UI — `app/pages/memories.vue`
Search (hybrid), scope filter, unreviewed toggle, cards (content/scope/tags/source). Search results show a **relevance** badge. List mode showed **confidence** until cycle 77; it now shows the audit, Jev and "at extraction" scores, with score filters and sorts (see [`/memories`](#memories)). Archive only — see below for where the human review gate moved. **Provenance (cycle 13):** each card surfaces its source-session link, the verbatim `quote` + `reasoning` from its evidence, and relation badges (→ supersedes / ← superseded-by / ⚠ contradicts). `/review` renders memory-conflict items (New vs Existing + Accept / Keep-both). **Cycle 24:** cards show the **source date** (`sourceDate ?? createdAt`, so imported history reads backdated, not "today") + a **project** badge, with a **project filter** (`USelectMenu`) alongside scope/tags.

**capture-triage task 13 — the human review gate ("Mark reviewed") moved to `/review`.**
`/memories`' "Unreviewed only" toggle is now a **filter/view only**; the button that strips
the `unreviewed` tag and sets `reviewed_at` was removed from this page. `/review` renders
every unreviewed memory as a `memory-unreviewed` card (content/scope/tags/confidence) with
its own "Mark reviewed" action, wired to the same `reviewMemory(id)` composable call this
page used to make. `GET /api/review/count`'s `pending` now includes unreviewed memories, so
the sidebar's single "Review" badge covers them — the separate "Memory" nav badge is gone.
See [enrichment.md](enrichment.md)'s review-queue section for the merged-feed mechanics.

> The 457 imported bridget sessions (cycle 13 phase 3) feed this enrichment locally — no bridget memories were imported; they're regenerated here with provenance + the relationship graph.

**Cycle 23 — project association.** Enrichment now sets `project_id` **by scope**: `agent` memories inherit their source session's project, `user`/`world` memories stay `null` (global). `source_date` = the source session's `started_at`, advanced via SQL `greatest` when new evidence merges. The selector excludes sessions whose project is `active=false`. See [projects.md](projects.md).

**Cycle 24 — enrichment quality v2 (the cycle-13 prompt over-extracted ephemeral noise: test counts, the AI's own skills/workflow, transient bugs — and inflated confidence so the floor caught nothing).** The `SYSTEM_PROMPT` is now ruthlessly selective ("most sessions yield 0–3; an empty list is a correct answer"), with an explicit **reject list** (test counts, build/CI status, "current/now X", in-progress bugs, the AI's own skills/workflow, session narration, file paths/SHAs/in-flux versions) and **confidence re-anchored to DURABILITY, not observability** (a precisely-observed but ephemeral fact = LOW confidence). The `parseMemories` floor is **0.6** (was 0.3). Prod's first ~308 cycle-13-prompt memories were cleared + re-enriched under v2 — see the [prod-rollout handover](../handovers/2026-06-16-prod-rollout-and-memory-quality.md).

**Cycle 51 — agent-facing recall excludes unreviewed memories by default.** The `unreviewed`
state only ever gated the human UI; every agent read path saw raw enrichment output as
established fact. All three agent recall paths now filter it out:

- **`search_memories`** and **`get_recent_memories`** (MCP + in-process agent tools) pass
  `reviewed: true` unless the caller sets **`includeUnreviewed: true`** — an explicit opt-in,
  useful when triaging the queue itself.
  **Cycle 77 (final review M3):** both return each memory through `toRecallMemory`
  (`server/lib/agent/tools.ts`), which drops the score fields (`jevScore`, `jevAnswers`, the
  `audit*` fields, the prompt versions). The scores are for `/memories`, the API and the export:
  on recall they cost ~250 chars per memory and an agent reading "transient: …" beside a fact
  would discount it.
- **The automatic per-turn injection** (`buildMemoryContext`, `server/lib/agent/context.ts`)
  calls `searchMemories(q, { limit: 5, reviewed: true })`. This one fires on **every** voice
  turn (`server/api/voice/ws.ts`) with no agent decision behind it, so it has **no opt-out** —
  the `includeUnreviewed` flag covers only tools an agent explicitly chooses to call, and this
  path bypasses them entirely.

The web surface is deliberately **unchanged**: `/memories` and its REST endpoints still show
unreviewed rows (that page exists to review them), and `listMemories`' `reviewed` option keeps
its previous default of "no filter".

See [mcp.md](mcp.md) for the agent-facing tools.
