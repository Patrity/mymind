# Relative Rerank Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed absolute `rerankCutoff` in `rankCandidates` with a per-query **top-k + relative band** (anchored to the query's own top score), so the cutoff is robust to the reranker's length-dependent score scale.

**Architecture:** Pure-function change in `server/lib/search/rank.ts` + two config keys in `server/lib/search/config.ts` + the one call-site in `server/services/search.ts`. No schema, no palette, no API change. The exact-substring pin is preserved; the empty state becomes retrieval-based (a non-empty candidate pool always yields ≥1 hit).

**Tech Stack:** TypeScript (Nitro server) · vitest.

## Global Constraints

- Package manager: **pnpm** only. Gates: **`pnpm typecheck`** (0 errors), **`pnpm test`** (vitest), **`pnpm build`**. Lint is NOT a gate.
- Pure helpers get vitest unit tests (`test/*.test.ts`, importing from `../server/...`). DB/network wiring is verified by typecheck + the full suite (the established convention).
- `rankCandidates` new config shape is exactly **`cfg: { topK: number; relBand: number }`** (replacing `{ rerankCutoff: number }`).
- `SearchRelevanceConfig` DEFAULTS, verbatim: **`rerankTopK: 12`**, **`rerankRelBand: 0.6`**, `cosineFloor: 1.0`, `candidatesPerLane: 8`, `maxCandidates: 50`. The key `rerankCutoff` is **removed**.
- **Reranked-path rule:** sort by score desc; `topScore = scored[0].score`; keep a candidate iff `lexicalExact || score >= relBand * topScore`; then cap to `topK`.
- **Fallback-path rule (rerankScores null):** unchanged synthetic score `(lexicalExact ? 1 : 0) + 1/(1 + rrfRank)`, sort desc, cap to `topK` — **no band**.
- **Empty state:** never force `[]` via score — a non-empty pool always yields ≥1 hit (the top clears its own band); `[]` only when the pool is empty.
- **No palette change** — the server bounds the list; `AppSearch.client.vue` already renders `hits`.
- Field-strip + 3dp score rounding in the output mapping stay exactly as today.

---

## File Structure

**Modify:**
- `server/lib/search/config.ts` — drop `rerankCutoff`; add `rerankTopK`, `rerankRelBand`.
- `server/lib/search/rank.ts` — `rankCandidates` cutoff logic + signature.
- `server/services/search.ts` — the `rankCandidates(...)` call-site (one line).
- `test/search-config.test.ts` — new defaults.
- `test/search-rank.test.ts` — rewrite for top-k + relative band.

---

## Task 1: Cutoff logic + config (pure, TDD)

**Files:**
- Modify: `server/lib/search/config.ts`
- Modify: `server/lib/search/rank.ts`
- Test: `test/search-config.test.ts`, `test/search-rank.test.ts`

**Interfaces:**
- Produces: `SearchRelevanceConfig` with `rerankTopK: number` + `rerankRelBand: number` (no `rerankCutoff`); `rankCandidates(candidates: Candidate[], rerankScores: Map<string,number> | null, cfg: { topK: number; relBand: number }): SearchHit[]`.
- Consumed by: Task 2 (`searchAll`).

- [ ] **Step 1: Update the config test (`test/search-config.test.ts`)**

Replace the whole file:
```ts
import { describe, it, expect } from 'vitest'
import { mergeSearchConfig } from '../server/lib/search/config'

describe('mergeSearchConfig', () => {
  it('returns defaults for empty/null input', () => {
    expect(mergeSearchConfig(null)).toEqual({
      rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
    })
    expect(mergeSearchConfig(undefined)).toEqual(mergeSearchConfig({}))
  })
  it('overrides only provided keys', () => {
    expect(mergeSearchConfig({ rerankRelBand: 0.5, cosineFloor: 0.7 })).toEqual({
      rerankTopK: 12, rerankRelBand: 0.5, cosineFloor: 0.7, candidatesPerLane: 8, maxCandidates: 50
    })
  })
})
```

- [ ] **Step 2: Run the config test — verify it FAILS**

Run: `pnpm vitest run test/search-config.test.ts`
Expected: FAIL — the current defaults still have `rerankCutoff: 0.2` and no `rerankTopK`/`rerankRelBand`.

- [ ] **Step 3: Update `server/lib/search/config.ts`**

Replace the interface + DEFAULTS:
```ts
export interface SearchRelevanceConfig {
  rerankTopK: number         // max hits returned (top-k cap, both reranked + fallback paths)
  rerankRelBand: number      // reranked: keep hits with score >= rerankRelBand * topScore (0..1)
  cosineFloor: number        // max cosine distance kept per vector lane (drop distance > floor)
  candidatesPerLane: number  // top-K per lane fed to the aggregator
  maxCandidates: number      // cap on the pool sent to the reranker
}

// Defaults are deliberately permissive: cosineFloor 1.0 keeps anything more similar
// than orthogonal (hides nothing before tuning). The rerank cutoff is RELATIVE
// (rerankRelBand × the query's own top score) so it's robust to the reranker's
// length-dependent score scale; rerankTopK bounds the palette list. Tune via the
// `search_relevance` settings key (no redeploy).
const DEFAULTS: SearchRelevanceConfig = {
  rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
}
```
(Leave the imports, `KEY`, `mergeSearchConfig`, and `getSearchConfig` unchanged — `mergeSearchConfig` already spreads over the new DEFAULTS, and the cast on `row?.value` stays as-is.)

- [ ] **Step 4: Run the config test — verify it PASSES**

Run: `pnpm vitest run test/search-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewrite the rank test (`test/search-rank.test.ts`)**

Replace the whole file:
```ts
import { describe, it, expect } from 'vitest'
import { rankCandidates, type Candidate } from '../server/lib/search/rank'

const c = (over: Partial<Candidate>): Candidate => ({
  type: 'document', id: 'x', title: 'X', snippet: null, to: '/x', icon: 'i',
  meta: null, rerankText: 'x', lexicalExact: false, rrfRank: 0, ...over
})
const CFG = { topK: 12, relBand: 0.5 }

describe('rankCandidates', () => {
  it('reranked: drops below the relative band (relBand × topScore)', () => {
    // top=1.0, band 0.5 → threshold 0.5: keep 1.0 and 0.6, drop 0.3
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 1.0], ['document:b', 0.3], ['document:c', 0.6]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])  // b (0.3) dropped — a fixed 0.2 cutoff would've kept it
    expect(hits[0]).toMatchObject({ id: 'a', score: 1 })
  })
  it('band is relative to the top score, not absolute', () => {
    // top=0.4, band 0.5 → threshold 0.2: keep 0.4 and 0.25, drop 0.1
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 0.4], ['document:b', 0.1], ['document:c', 0.25]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])  // c (0.25) kept though a fixed 0.5 cutoff would drop it
  })
  it('pins exact lexical matches even below the band', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b', lexicalExact: true })]
    const scores = new Map([['document:a', 1.0], ['document:b', 0.01]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a', 'b'])  // b kept (pinned), ranked last
  })
  it('caps the reranked result to topK', () => {
    const cands = Array.from({ length: 5 }, (_, i) => c({ id: `d${i}` }))
    const scores = new Map(cands.map((_, i) => [`document:d${i}`, 1 - i * 0.01]))  // all ~1.0, within band
    const hits = rankCandidates(cands, scores, { topK: 3, relBand: 0.5 })
    expect(hits.map(h => h.id)).toEqual(['d0', 'd1', 'd2'])
  })
  it('non-empty pool always yields ≥1 hit (top clears its own band)', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' })]
    const scores = new Map([['document:a', 0.05], ['document:b', 0.02]])
    const hits = rankCandidates(cands, scores, CFG)
    expect(hits.map(h => h.id)).toEqual(['a'])  // a is the top (0.05>=0.025); b (0.02<0.025) dropped
  })
  it('empty pool → []', () => {
    expect(rankCandidates([], new Map(), CFG)).toEqual([])
    expect(rankCandidates([], null, CFG)).toEqual([])
  })
  it('fallback (no scores): reciprocal lane rank, exact matches lead', () => {
    const cands = [
      c({ id: 'a', rrfRank: 0 }),
      c({ id: 'b', rrfRank: 2, lexicalExact: true }),
      c({ id: 'c', rrfRank: 1 })
    ]
    const hits = rankCandidates(cands, null, CFG)
    expect(hits.map(h => h.id)).toEqual(['b', 'a', 'c'])  // b boosted by lexicalExact
  })
  it('fallback caps to topK', () => {
    const cands = Array.from({ length: 5 }, (_, i) => c({ id: `e${i}`, rrfRank: i }))
    const hits = rankCandidates(cands, null, { topK: 2, relBand: 0.5 })
    expect(hits.map(h => h.id)).toEqual(['e0', 'e1'])
  })
  it('strips internal fields from the returned SearchHit', () => {
    const hit = rankCandidates([c({ id: 'a' })], null, CFG)[0]
    expect(Object.keys(hit).sort()).toEqual(['icon', 'id', 'meta', 'score', 'snippet', 'title', 'to', 'type'])
  })
})
```

- [ ] **Step 6: Run the rank test — verify it FAILS**

Run: `pnpm vitest run test/search-rank.test.ts`
Expected: FAIL — `rankCandidates` still takes `{ rerankCutoff }` and applies an absolute cutoff (and TypeScript will reject `CFG = { topK, relBand }`).

- [ ] **Step 7: Rewrite `server/lib/search/rank.ts`**

Keep the imports + the `Candidate` interface + `round3` as-is. Replace `rankCandidates`:
```ts
/**
 * Rank candidates into the final SearchHit list.
 *
 * - rerankScores present → score = raw cross-encoder score; sort desc; keep a
 *   candidate iff lexicalExact OR score >= relBand × topScore (a RELATIVE band
 *   anchored to the query's own top hit — robust to the reranker's
 *   length-dependent absolute scale); then cap to topK.
 * - rerankScores null (reranker off/failed) → synthetic score = reciprocal lane
 *   rank + a boost for exact matches; sort desc; cap to topK (no band).
 *
 * Empty state is retrieval-based: a non-empty pool always yields ≥1 hit (the top
 * clears its own relative band), so [] ⟺ the candidate pool was empty.
 */
export function rankCandidates(
  candidates: Candidate[],
  rerankScores: Map<string, number> | null,
  cfg: { topK: number; relBand: number }
): SearchHit[] {
  const key = (c: Candidate) => `${c.type}:${c.id}`

  let scored: Array<{ c: Candidate; score: number }>
  if (rerankScores) {
    scored = candidates
      .map(c => ({ c, score: rerankScores.get(key(c)) ?? 0 }))
      .sort((a, b) => b.score - a.score)
    const topScore = scored.length ? scored[0]!.score : 0
    const threshold = cfg.relBand * topScore
    scored = scored.filter(({ c, score }) => c.lexicalExact || score >= threshold)
  } else {
    scored = candidates
      .map(c => ({ c, score: (c.lexicalExact ? 1 : 0) + 1 / (1 + c.rrfRank) }))
      .sort((a, b) => b.score - a.score)
  }

  return scored.slice(0, cfg.topK).map(({ c, score }) => ({
    type: c.type, id: c.id, title: c.title, snippet: c.snippet,
    score: round3(score), to: c.to, icon: c.icon, meta: c.meta
  }))
}
```

- [ ] **Step 8: Run the rank test — verify it PASSES**

Run: `pnpm vitest run test/search-rank.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 9: Run both updated tests together**

Run: `pnpm vitest run test/search-rank.test.ts test/search-config.test.ts`
Expected: PASS (11 tests total).

> Note: `pnpm typecheck` will now report errors ONLY in `server/services/search.ts` (it still passes `{ rerankCutoff: cfg.rerankCutoff }` to `rankCandidates`, and `cfg.rerankCutoff` no longer exists). That is expected and fixed in Task 2. Do NOT touch `search.ts` here.

- [ ] **Step 10: Commit**
```bash
git add server/lib/search/config.ts server/lib/search/rank.ts test/search-config.test.ts test/search-rank.test.ts
git commit -m "feat(search): relative rerank cutoff (top-k + band) replacing the fixed absolute floor"
```

---

## Task 2: Wire the `searchAll` call-site

**Files:**
- Modify: `server/services/search.ts` (the `rankCandidates(...)` call, ~line 152)

**Interfaces:**
- Consumes: `rankCandidates(..., cfg: { topK, relBand })` + `getSearchConfig()` returning `{ rerankTopK, rerankRelBand, ... }` (Task 1).

- [ ] **Step 1: Update the call-site in `server/services/search.ts`**

Replace the single line:
```ts
  const hits = rankCandidates(pool, rerankScores, { rerankCutoff: cfg.rerankCutoff })
```
with:
```ts
  const hits = rankCandidates(pool, rerankScores, { topK: cfg.rerankTopK, relBand: cfg.rerankRelBand })
```
(Nothing else in `searchAll` changes — the lane fan-out, the pool cap at `cfg.maxCandidates`, the `resolveChain('rerank')` guard, and the empty-rerank guard `results.length ? new Map(...) : null` all stay.)

- [ ] **Step 2: Typecheck — verify clean**

Run: `pnpm typecheck`
Expected: 0 errors (the Task-1 `search.ts` error is now resolved; no other file references `rerankCutoff`).

- [ ] **Step 3: Full test suite — verify green**

Run: `pnpm test`
Expected: all pass (the 11 updated search tests + the rest of the suite; nothing else depends on `rerankCutoff`).

- [ ] **Step 4: Build — verify it succeeds**

Run: `pnpm build`
Expected: `Build complete!`

- [ ] **Step 5: Commit**
```bash
git add server/services/search.ts
git commit -m "feat(search): pass top-k + relative band to rankCandidates in searchAll"
```

---

## Self-Review

**Spec coverage:**
- Top-k + relative band in `rankCandidates` → Task 1 Step 7. ✅
- Exact-pin preserved (`lexicalExact || score >= threshold`) → Task 1 Step 7 + the "pins exact" test. ✅
- Fallback path: synthetic score, sort, top-k cap, no band → Task 1 Step 7 + the fallback tests. ✅
- Empty state retrieval-based (non-empty pool → ≥1 hit; `[]` only when pool empty) → Task 1 Step 7 + the "non-empty pool" / "empty pool" tests. ✅
- Config: drop `rerankCutoff`, add `rerankTopK: 12` + `rerankRelBand: 0.6` → Task 1 Steps 1–4. ✅
- Call-site passes `{ topK, relBand }` → Task 2 Step 1. ✅
- No palette change → not in scope; no task touches `AppSearch.client.vue`. ✅
- Field-strip + 3dp rounding unchanged → preserved verbatim in Task 1 Step 7. ✅

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**Type consistency:** `rankCandidates` signature `cfg: { topK: number; relBand: number }` (Task 1) is exactly what the Task-2 call-site passes (`{ topK: cfg.rerankTopK, relBand: cfg.rerankRelBand }`); `SearchRelevanceConfig` keys `rerankTopK`/`rerankRelBand` (Task 1 config) match the Task-2 reads; `Candidate` + `SearchHit` shapes unchanged. ✅
