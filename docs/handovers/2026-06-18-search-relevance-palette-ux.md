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
Probed `192.168.2.25:8883` directly. TEI `/rerank` returns `{results:[{index, score, text}]}`
— the field is **`score`** (not `relevance_score`); the Task-2 adapter was corrected to read
it. **Caveat found and confirmed at scale in E2E (below): the rig reranker is miscalibrated.**

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

## ⚠️ Important finding — the rig reranker is miscalibrated (operational, not a code bug)
A **nonsense** query (`zzzqqxnomatchxyzzy`) came back with 24 hits scored up to **0.999** — the
rig reranker assigns high relevance to garbage. A distance probe showed why the cosine floor
can't compensate: in this embedding space a real query's nearest chunk (0.672) and a gibberish
query's nearest (0.710) differ by only ~0.04 — distances cluster too tightly for a floor to
separate relevant from noise. So **with the current rig + permissive defaults, the
"drop-the-noise / empty-state" goal is NOT met out of the box**, and enabling the reranker can
*reorder by bad scores* (e.g. "humanizer skill" ranked #1 for "document chunking").

**Recommendation (carried as the merge's headline caveat):**
- Keep the `rerank` usage **unassigned in prod for now**. Even off, this cycle is a clear win
  over master: ONE unified relevance-ranked list, exact matches pinned to the top, matched
  snippets, empty groups hidden, score badges when reranked.
- Recalibrate the rig reranker (almost certainly a missing **Qwen3 instruction template** /
  model-config issue on `:8883`) — a homelab task. Then assign the `rerank` model and tune
  `rerankCutoff` / `cosineFloor` on the **real prod corpus** (bigger, and where the original
  "PR #835 pending" case lives) via the `search_relevance` settings key. The reranker is the
  precision lever; the cosine floor alone is blunt here.

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
  *quality* depends on the rig recalibration above. Validate post-deploy once the reranker is
  fixed + assigned.
- Merge via `finishing-a-development-branch`; `master` auto-deploys. No migration (config is a
  settings key; the legacy `documents.embedding` columns are untouched).

## Deferred follow-ons
- Recalibrate the rig reranker; enable + tune on prod.
- Cross-type rerank for the MCP `search_docs` / `search_passages` (agent-facing).
- Contextual BM25 over chunk text; a `/settings` relevance-tuning UI tab for `search_relevance`.
