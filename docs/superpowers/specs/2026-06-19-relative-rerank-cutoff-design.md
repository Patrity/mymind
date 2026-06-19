---
title: Relative Rerank Cutoff — design
cycle: 33
date: 2026-06-19
status: spec
follows: 2026-06-18-search-relevance-palette-ux-design.md
task: 96ffb5bb
related:
  - ../../wiki/search.md
  - ../../handovers/2026-06-18-search-relevance-palette-ux.md
---

# Relative Rerank Cutoff

## Problem
Cycle 32 shipped a **fixed absolute** `rerankCutoff: 0.2` in `rankCandidates`
(`server/lib/search/rank.ts`). Verified against the rig, the reranker's score scale is
**length-dependent** (same content scored ~0.29 at 46 chars vs ~0.50 padded to ~600 chars —
irrelevant filler *raised* the score). So a fixed absolute floor is structurally fragile: it
over- or under-trims depending on passage length, regardless of model size.

Separately, the rig reranker was upgraded `Qwen3-Reranker-0.6B-seq-cls` →
**`mixedbread-ai/mxbai-rerank-large-v2`** (verified 2026-06-19). The new model ranks correctly
and lands relevant docs at a reliable **~1.0** (the 0.6B *inverted* technical/entity queries —
e.g. "Intel X550" → relevant 0.107, lowest). But irrelevant docs still **scatter 0.0–0.9**
(blog 0.52 for "Intel X550", humanizer 0.91 for "Chatterbox TTS port", gibberish queries
0.49–0.95), so "irrelevant ≈ 0" does **not** hold. A reliable ~1.0 top + scattered irrelevant
is exactly the distribution a relative band (anchored to the top) handles cleanly and an
absolute floor does not.

## Decisions (user-approved 2026-06-19)
1. **Cutoff = top-k + relative band** — no fixed absolute floor.
2. **Empty state = best-guess** — `hits = []` only when retrieval itself returns nothing
   (no lexical match AND no vector hit within the cosine floor), never forced by score.

## Change — `server/lib/search/rank.ts`
`rankCandidates(candidates, rerankScores | null, cfg)` — replace `cfg.rerankCutoff` with
`cfg.rerankTopK` (number) + `cfg.rerankRelBand` (number, 0..1):

- **Reranked path** (`rerankScores` present): score each candidate `rerankScores.get(key) ?? 0`
  (`key = `${type}:${id}``); sort by score desc; `topScore = scored[0].score`; **keep** a
  candidate iff `lexicalExact || score >= rerankRelBand * topScore`; then **cap to `rerankTopK`**
  (`slice(0, topK)`).
- **Fallback path** (`rerankScores` null): unchanged synthetic score
  `(lexicalExact ? 1 : 0) + 1/(1 + rrfRank)`, sort desc, **cap to `rerankTopK`** — **no band**
  (synthetic rank-scores are positional, not relevance magnitudes; a ratio band would cut by
  rank position, not relevance).
- Output mapping to `SearchHit` (field-strip + 3dp score rounding) unchanged.

**Empty state needs no new code.** With the absolute floor gone, the top hit always clears the
relative band (`topScore >= rerankRelBand * topScore` for any band ≤ 1), so a non-empty pool
always yields ≥1 hit ⇒ `hits = []` ⟺ the candidate pool is empty ⟺ the lanes returned nothing.
The permissive `cosineFloor` (default 1.0) stays — we deliberately do **not** score-gate
emptiness (gibberish queries score high, so a score-based empty test is unreliable; emptiness
is a *retrieval* fact, not a *rerank* fact).

## Change — `server/lib/search/config.ts`
`SearchRelevanceConfig`: **drop** `rerankCutoff`; **add** `rerankTopK: 12`, `rerankRelBand: 0.6`.
Keep `cosineFloor`, `candidatesPerLane`, `maxCandidates`. Defaults are tunable without redeploy
via the `search_relevance` settings key. `rerankRelBand: 0.6` chosen from the mxbai data: with
relevant ≈ 1.0, a 0.6 band drops the ~0.5 false-positive tail while keeping the relevant doc
and legitimate secondary hits; `rerankTopK: 12` bounds the palette list.

## Change — `server/services/search.ts`
`searchAll` passes `{ topK: cfg.rerankTopK, relBand: cfg.rerankRelBand }` to `rankCandidates`
instead of `{ rerankCutoff: cfg.rerankCutoff }`. The empty-rerank guard
(`rerankScores = results.length ? new Map(...) : null`) stays. No other change.

## No palette change
The server now bounds the result list to `rerankTopK`; `app/components/AppSearch.client.vue`
already renders `hits` as a "Top results" group + per-type groups and needs no edit.

## Testing
Pure-helper unit tests only (the established convention; wiring verified by typecheck + the full
suite):
- `test/search-rank.test.ts` — rewrite for the new logic: reranked path (band keeps
  `score >= relBand × topScore`, exact-pin survives below the band, top-k cap, sort desc);
  fallback path (sort + top-k cap, no band); a non-empty pool never yields `[]`; `[]` in → `[]` out.
- `test/search-config.test.ts` — update for the new defaults (`rerankTopK`/`rerankRelBand`,
  `rerankCutoff` gone).

## Scope / non-goals
- **In:** the cutoff logic (`rank.ts`), config keys (`config.ts`), the `searchAll` call-site,
  and the two test files.
- **Out (deliberately):** the rig model swap (already done — `mxbai-rerank-large-v2` live);
  *enabling* the `rerank` usage in prod (user's call post-merge — now worth it with mxbai);
  cosine-floor changes; cross-type rerank for the MCP `search_docs`/`search_passages`.
- **Behavioural note:** with the `rerank` usage **unassigned** (current prod), the only visible
  effect is the palette returning ≤ `rerankTopK` (12) hits instead of ≤ `maxCandidates` (50) —
  a tighter list. The relative-band trimming only engages once a reranker is assigned.

## Open questions
None blocking. `rerankRelBand` / `rerankTopK` defaults are best-guess from current data and
explicitly tunable post-deploy.
