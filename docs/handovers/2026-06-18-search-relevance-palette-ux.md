---
title: Search Relevance + Command-Palette UX — reranker, cutoff, snippets, unified ranking
cycle: 32
date: 2026-06-18
status: shipped
branch: worktree-search-relevance
task: 03fd2aef (subsumes reranker-enablement task e356a621)
spec: ../superpowers/specs/2026-06-18-search-relevance-palette-ux-design.md
plans:
  - ../superpowers/plans/2026-06-18-search-relevance-palette-ux.md
wiki:
  - ../wiki/search.md
shipped:
  - "**Raw-score reranker** (`server/lib/ai/rerank.ts`) — dropped the min-max normalisation (it destroyed the absolute signal a cutoff needs); `rerank()` now returns RAW cross-encoder scores and THROWS on failure (callers choose the fallback). New pure `parseRerankResponse(raw, ids)` reads the rig's `score` field (Task-1 spike finding; `relevance_score` accepted as a fallback). `searchMemories` call-site updated. (4 unit tests)"
  - "**`search_relevance` config** (`server/lib/search/config.ts`) — `getSearchConfig()` over the `search_relevance` settings key (mirrors chunking config): `{ rerankCutoff:0.2, cosineFloor:1.0, candidatesPerLane:8, maxCandidates:50 }`, tunable without redeploy. (2 unit tests)"
  - "**Distance-aware collapse** (`server/lib/chunking/collapse.ts` `collapseChunksToHits`) — best (min) distance per source, for the floor. (2 unit tests)"
  - "**Per-lane cosine floor** — all 6 vector lanes (`searchDocs`, `searchImages` summary+OCR, `searchMemories`, `searchSessions`, `searchMessages`) now select the distance and drop candidates past `cosineFloor`. Always-on reranker-off fallback; also reaches the MCP `search_docs`."
  - "**Snippet + highlight** — `makeSnippet(text,q)` (`server/lib/search/snippet.ts`, window around the matched token; clamps long matched phrases) + `highlightTokens(text,q)` (`app/utils/highlight.ts`, `<mark>` segments). (6 + 4 unit tests)"
  - "**Unified contract + pure ranker** (`shared/types/search.ts`, `server/lib/search/rank.ts`) — `SearchResults` is now `{ hits: SearchHit[]; reranked: boolean }` (the 7 per-type arrays collapsed; `SessionResult`/`MessageResult` kept as lane shapes). `rankCandidates(candidates, rerankScores|null, cfg)`: with scores → drop below `rerankCutoff` EXCEPT exact-substring matches (pinned), sort desc; without → synthetic RRF rank, no cutoff. (5 unit tests)"
  - "**Aggregator rewrite** (`server/services/search.ts`) — `searchAll(q)` builds `Candidate[]` per lane (doc snippet = best chunk passage via `searchPassages`), pools (capped), makes ONE cross-type `rerank` call gated on `resolveChain('rerank')` (try/caught → null on failure OR empty result), runs `rankCandidates`, returns `{ hits, reranked }`. `search.get.ts` + `useGlobalSearch` migrated."
  - "**Option-A palette** (`app/components/AppSearch.client.vue`) — a 'Top results' group (top ~6 hits, mixed type, snippet + highlight + score badge) over per-type groups (empty omitted), all from the one `hits` list; score badges only when `reranked`. Built on `UCommandPalette` `#hit-*` slots (v4: `CommandPaletteGroup<CommandPaletteItem>`)."
  - "Built subagent-driven (10 tasks, fresh implementer + two-verdict task review each, opus whole-branch review). Gates: **typecheck 0 / test 451 / build**. Live E2E on the dev rigs via playwright-cli (see below)."
---

# Search Relevance + Command-Palette UX (cycle 32)

Fixes noisy global search: vector lanes returned top-N neighbours with no relevance
threshold; the reranker was built but wired only into memories and off; the palette showed
fixed 5-per-type groups with no score, ranking, or snippet. Full behaviour:
[wiki/search.md](../wiki/search.md).

## How it was built
Brainstorm → spec → plan → subagent-driven build, in an isolated worktree
(`.claude/worktrees/search-relevance`, branch `worktree-search-relevance`). User-approved
decisions: cross-type rerank in the aggregator (ONE call); per-lane cosine floor as the
always-on fallback; raw rerank scores (not min-max) + absolute cutoff + exact-substring pin;
unified `hits` contract; "show nothing" empty state; Option-A palette; reranker enabled only
by assigning the `rerank` usage in `/settings`. MCP-side reranking deferred (only the floor
reaches `search_docs` this cycle).

## Task-1 spike (the reranker rig)
Probed `192.168.2.25:8883` directly. The bare `/rerank` returns `{results:[{index, score, text}]}`
(field `score`); the Cohere `/v1`–`/v2` routes return the same numbers in a `relevance_score`
envelope. The Task-2 adapter reads `score` || `relevance_score`, so both work. (NOTE: the spike's
own `model`-less curls produced misleading scores — the `model` field turns out to be ignored by
the shim; see the corrected Finding below. The real caveat is the length-dependent score scale.)

## Live E2E (playwright-cli, dev rigs, 2026-06-18) — what was proven
Ran against a worktree dev server (`:3001`) on the shared local dev DB + the real rigs
(embeddings `:8882`, rerank `:8883`):
- **Contract**: `/api/search?q=` returns `{ hits, reranked }`; 34 cross-type hits in one
  ranked list, every hit carrying the 8 `SearchHit` keys + a snippet. ✅
- **Fallback path** (no `rerank` model assigned, the dev/prod default): `reranked:false`,
  synthetic RRF scores, top hit `score:2` (= `1 + 1/(1+0)` for a rank-0 exact match → exact-pin
  + fallback ordering working), no score badges in the UI. ✅
- **Reranked path** (assigned a rerank model in dev ai-config for the test, then reverted):
  `reranked:true`, RAW scores in [0,1], cutoff trimmed 34→30, a surviving `score:0.004` proved
  the **exact-pin** keeps a sub-cutoff substring match. ✅
- **UI** (screenshot): the palette renders the "Top results" group (mixed types, icons, title
  + matched snippet + score badge 0.96…0.66) over a "Documents" per-type group. ✅

## ⚠️ Finding — reranker score *scale*, not the rig/shim (corrected 2026-06-19 after verification)
The first version of this handover claimed the rig reranker was "miscalibrated" (cat-photo >
deploy-runbook, gibberish→0.999, off-topic > on-topic). **A follow-up verification against the
rig (`192.168.2.25:8883`) retracted those causal claims — they were test artifacts:**
- The **`model` field is ignored** by the Cohere shim (proven byte-identical with / without / a
  bogus model); it was never "load-bearing." The **Cohere shim is fully compatible**: our client
  posts `{ model, query, documents }` and reads `relevance_score` || `score`; `/rerank`,
  `/v1/rerank`, `/v2/rerank` return identical scores (set the provider `baseURL` prefix to match).
- "cat-photo > runbook" was the **specific input strings** flipping the result (same query/model,
  only the doc text differed), not a model defect.
- "off-topic > on-topic" was a **length confound** — at equal length in the in-app regime
  (≤512-char best-chunk passages) the 0.6B orders correctly (on-topic 0.815 > off-topic 0.805),
  if with razor-thin separation.

The **one verified, real** issue: the reranker's **absolute score scale is length-dependent**
(same content ~0.29 @46 chars vs ~0.50 padded to ~600 chars — irrelevant filler *raised* the
score). That makes the **fixed `rerankCutoff` shipped this cycle fragile**, independent of model.

**Recommendation (corrected):**
- The structural fix is a **per-query relative cutoff / top-k**, not the fixed absolute floor —
  robust to the length-dependent scale. The key follow-up (own cycle; task `96ffb5bb`).
- A stronger reranker (`tomaarsen/Qwen3-Reranker-4B-seq-cls` — the shim's **own default**;
  running 0.6B only due to a compose override; 8B also exists) sharpens separation but is a
  **VRAM-placement decision** on the shared Zotac GPU (~17/24 GB used; 4B ~8–9 GB), not a one-liner.
- **Don't write off the 0.6B:** in the clipped in-app regime it orders clean/equal-length cases
  correctly. Re-evaluate enabling the `rerank` usage in prod once the cutoff is relative (with
  rerank off, search falls back to RRF-lane fusion, which isn't free).

## Final review
Opus whole-branch review: **Ready to merge — with fixes.** No Critical, no code defects.
Verified cross-cutting correctness (rerank id key `${type}:${id}` matches `rankCandidates`;
graceful degradation never throws; contract migration left no stale consumer; no SQL injection)
and ran all three gates. Two actionable items: (1) wiki + handover (= this) — done; (2) a
one-line guard so an empty rig response falls back to RRF instead of dropping everything —
**fixed** (`fix(search): fall back to RRF order when the reranker returns an empty result set`).
Minor findings (config-cast pattern, JSDoc precondition, full-`content` lexicalExact perf at
high K) recorded as non-blocking.

## Pending acceptance
- **Reranked relevance on the real prod corpus has NOT been validated** (the dev corpus is tiny
  + different; the original "PR #835 pending" docs live in prod). The mechanism is proven; the
  *quality* gate is the **relative-cutoff** rework above (the fixed absolute cutoff fights the
  length-dependent score scale). Re-evaluate enabling the `rerank` usage in prod after that.
- Merge via `finishing-a-development-branch`; `master` auto-deploys. No migration (config is a
  settings key; the legacy `documents.embedding` columns are untouched).

## Deferred follow-ons
- Recalibrate the rig reranker; enable + tune on prod.
- Cross-type rerank for the MCP `search_docs` / `search_passages` (agent-facing).
- Contextual BM25 over chunk text; a `/settings` relevance-tuning UI tab for `search_relevance`.
