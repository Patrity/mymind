---
title: Search Relevance + Command-Palette UX — design
cycle: 32
date: 2026-06-18
status: spec
task: 03fd2aef (subsumes reranker-enablement task e356a621)
branch: worktree-search-relevance
related:
  - ../../wiki/search.md
  - ../../wiki/chunking.md
  - ../../handovers/2026-06-18-document-chunking.md
---

# Search Relevance + Command-Palette UX

## Problem

Cycle-31 chunking fixed *retrieval* (docs over TEI's 16k limit are now indexed and
findable). But search results are **noisy**: searching a specific hidden phrase
(e.g. `"PR #835 pending"`) returns the 2 correct docs **plus** a tail of irrelevant
docs and random memories, with **no relevance signal in the UI**.

### Verified root causes (read from code, not assumed)

1. **No relevance floor on any vector lane.** `searchDocs`
   (`server/services/documents.ts`), `searchImages` (`server/services/images.ts`),
   `searchMemories` (`server/services/memory.ts`), `searchSessions`/`searchMessages`
   (`server/services/session-search.ts`) all do
   `ORDER BY embedding <=> query LIMIT 50/100` — pure top-N nearest neighbours, no
   distance threshold. On a homogeneous corpus the 50th-nearest doc is still
   returned, so the vector lane floods candidates regardless of true relevance.
2. **RRF blends a precise lane with a recall-heavy lane.** `rrfFuse([trigramIds,
   vectorIds])` (`server/lib/ai/rrf.ts`, k=60) — trigram returns a few exact-substring
   hits (`ILIKE %q%`); vector pads up to 50. Nothing else fills the group, so
   vector-only noise surfaces to pad `perGroup`.
3. **The reranker is built but unused for docs.** `server/lib/ai/rerank.ts` is a
   complete TEI-style `/rerank` client (never throws; resolves the model via
   `resolveChain('rerank')` from the AI config registry). It is wired into
   `searchMemories` **only**, and "off" purely because no model is assigned to the
   `rerank` usage in `/settings`. `searchDocs`/images/sessions/messages have **no
   rerank hook**.
4. **Palette UI is flat and signal-free.** `app/components/AppSearch.client.vue`
   builds 7 fixed type-groups, each sliced to 5 (`searchAll` `perGroup=5`), with **no
   score**, **no cross-type ranking**, and **no matched snippet** (you can't see *why*
   a result matched).

### Non-obvious finding that shapes the design

`rerank.ts` **min-max normalises** scores to `[0,1]` within the candidate set — the top
hit is always `1.0`, the worst always `0.0`, regardless of true relevance. Fine for
memory's reorder-only use, but it **destroys the absolute signal a cutoff needs**. A real
"drop the noise" cutoff must threshold on the **raw** `relevance_score`.

### Key constraint

The reranker (`Qwen3-Reranker-0.6B`, `192.168.2.25:8883`) shares the Zotac GPU with the
voice trio + TEI (~6.5 GB free, spiky). So **how many** rerank calls we make per keystroke
matters → favour one cross-type call over N per-lane calls.

## Decisions (user-approved 2026-06-18)

| # | Decision | Choice |
|---|---|---|
| 1 | Where rerank + cutoff live | **Cross-type, in the aggregator** — one rerank call per query over all fused candidates; globally-comparable raw scores → a true unified ranking + one meaningful cutoff. Per-lane **cosine floor** is the always-on reranker-off/down fallback. |
| 2 | Palette layout | **Option A — "Top results" + trimmed type-groups**, on `UCommandPalette` via slots (roll-our-own only if a slot blocks us). |
| 3 | Weak-match behaviour | **Show nothing + empty state** when nothing clears the bar; **exact substring/trigram matches are always kept** regardless of score. |
| 4 | Contract | **One ranked `hits` list** returned by `searchAll`; the client builds both the Top-results section and the per-type groups from it. |
| 5 | MCP reranking | **Deferred** — only the per-lane cosine floor reaches the MCP `search_docs`/`search_passages` this cycle. |

## Architecture & data flow

Reranking + cutoff move into **`searchAll`**. The cosine floor stays **in each lane**
(shared improvement; also trims the MCP `search_docs` path and bounds the candidate set
fed to the reranker).

```
searchAll(q):
  1. Fan out the 7 lanes in parallel (as today). Each returns its top-K (≈ candidatesPerLane)
     CANDIDATES, not display rows:
        Candidate = { type, id, to, title, snippet, rerankText, lexicalExact, rrfRank }
     - vector lanes drop candidates past the COSINE FLOOR before returning   ← always-on
     - lexicalExact = true when the row matched via an exact substring (ILIKE) hit
  2. Flatten lanes → one candidate pool (capped at ≈ maxCandidates, e.g. 50).
  3. If the `rerank` usage is configured (resolveChain('rerank') succeeds):
        ONE rerank(q, pool.map(c => c.rerankText)) → RAW relevance_score per candidate.
        score = rawScore.
        Drop candidates with score < rerankCutoff, EXCEPT lexicalExact ones (pinned).
     Else (unconfigured, or rerank threw/timed out):
        score = normalized RRF rank (1/(1+rank)); the cosine floor already trimmed the lane.
  4. Sort the surviving candidates by score desc → SearchHit[].
  5. return { hits }.
```

Per-candidate `rerankText` by type:
- **document** → best-matching chunk passage `content` (cycle-31 chunks); trigram-only
  hit with no chunk → `title` + content excerpt.
- **memory** → `content`. **image** → `summary` + OCR (or best OCR-chunk). **session** →
  `title` + `summary`. **message** → `content`. **task** → `title` + `description`.
  **project** → `name` + `slug`.

## Relevance mechanics

- **Raw scores.** Refactor `rerank.ts` to return the raw cross-encoder `relevance_score`
  (remove the min-max normalisation). `searchMemories` updated to use raw scores for both
  its displayed `relevance` and its reorder (raw sigmoid is monotonic, so ordering is
  preserved; its tests are updated to the new shape). The aggregator's absolute cutoff
  thresholds on raw score.
- **Exact-match pin.** Any candidate with `lexicalExact === true` is never removed by the
  cutoff. This is the guarantee that a known phrase (`"PR #835 pending"`) always returns
  its matching docs even if the reranker scores them oddly.
- **Graceful degradation.** Reranker unconfigured *or* throws/times out → fall back to
  cosine-floor-trimmed RRF ordering. Search never blocks (mirrors `rerank.ts`'s
  never-throws contract and the lanes' try/catch vector fallback).
- **Empty state.** If nothing clears the bar → `hits: []` → palette shows "No relevant
  results." (decision 3.)

## Contract change — `shared/types/search.ts`

Collapse the 7 fixed arrays into one ranked list:

```ts
export type SearchHitType =
  'document' | 'memory' | 'image' | 'task' | 'project' | 'session' | 'message'

export interface SearchHit {
  type: SearchHitType
  id: string
  title: string            // primary display line
  snippet: string | null   // matched passage / excerpt (may contain the matched phrase)
  score: number            // 0..1 — raw rerank score, or normalized-RRF when reranker off
  to: string               // route
  icon: string             // lucide icon name per type
  meta?: string | null     // type-specific: doc path / memory scope / task status / session project
}

export interface SearchResults { hits: SearchHit[] }
```

Blast radius is contained: `server/services/search.ts` (`searchAll`),
`server/api/search.get.ts`, `app/composables/useGlobalSearch.ts`,
`app/components/AppSearch.client.vue`. The lane-level `SessionResult`/`MessageResult`
shapes (consumed by `session-search.ts`) stay internal; the aggregator normalises every
lane into `SearchHit`.

## Snippets + highlight

- Pure **`makeSnippet(text, query, maxLen≈160)`** — picks the best window around matched
  query tokens, ellipsizes the ends; unit-tested. Doc snippet = best-matching chunk
  passage; other types = excerpt around the match in content/summary.
- Highlight is **client-side**: pure **`highlightTokens(snippet, query)`** → segments,
  rendered in the `#item-label` slot with semantic tokens (`text-highlighted` /
  `bg-primary/15`). Not relying on Fuse `includeMatches` (we bypass Fuse with
  `ignoreFilter: true`).

## Palette UI — Option A, on `UCommandPalette`

- A `{ id: 'top', label: 'Top results' }` group: the top ≈ `topCount` (6) hits across all
  types, each rendered with its type icon (leading), title + highlighted snippet
  (`#item-label`), and a small score badge (`#item-trailing`, `UBadge`/`UKbd`).
- Below it, per-type groups built by **bucketing `hits` by `type`**, score-ordered,
  **empty groups omitted**.
- Verified feasible on Nuxt UI v4: `UCommandPalette` exposes `#item`, `#item-leading`,
  `#item-label`, `#item-trailing` slots + per-group `slot`. Virtualization (which flattens
  groups) is **not** used — result counts are small. Roll-our-own remains the escape hatch
  if a slot blocks the layout.

## Config — `search_relevance` settings key

Mirrors `getChunkingConfig()`:

```ts
interface SearchRelevanceConfig {
  rerankCutoff: number       // raw-score floor when reranking (default conservative, e.g. 0.2)
  cosineFloor: number        // max cosine distance kept per vector lane (default permissive)
  candidatesPerLane: number  // top-K per lane fed to the aggregator (default 8)
  maxCandidates: number      // cap on the pool sent to the reranker (default 50)
  topCount: number           // size of the "Top results" group (default 6)
}
```

- `getSearchConfig()` reads the `search_relevance` key over these defaults. **Distinct
  from the existing `search` key** (cycle-29 web-search/SearXNG config —
  `server/api/settings/search.{get,put}.ts`). Tunable without redeploy because the
  cosine-floor + cutoff defaults need empirical tuning on the real corpus.
- **Enabling the reranker = assign a model to the `rerank` usage in the existing
  `/settings` AI tab** (`AssignmentsTab.vue` already iterates the usages incl. `rerank`).
  No new settings UI this cycle.

## Scope

**In:** aggregator cross-type rerank + absolute cutoff; per-lane cosine floor;
`rerank.ts` raw-score refactor (+ `searchMemories` update & tests); `makeSnippet` +
`highlightTokens`; unified `hits` contract; Option-A palette via slots; `search_relevance`
config key + `getSearchConfig()`.

**Out (follow-ons):** reranking the MCP `search_docs`/`search_passages` themselves (only
the cosine floor reaches them this cycle); contextual BM25 over chunk text; a dedicated
`/settings` relevance-tuning UI tab.

## Risks & validation

- **Reranker rig endpoint/format (highest risk).** **Task 1 spike** verifies `:8883`
  actually serves the TEI `/rerank` shape `rerank.ts` expects (`{model, query, documents}`
  → `{results:[{index, relevance_score}]}`) before anything is built on it. If the rig
  differs, adjust the adapter in Task 1.
- **Threshold tuning.** Cosine-floor + cutoff defaults need live tuning → they are config,
  not constants, with conservative/permissive defaults so nothing useful is hidden by
  accident.
- **Latency.** One added serial round-trip per query after the parallel lane fan-out
  (bounded pool, 5 s timeout, 250 ms debounce) — acceptable for a palette; failure →
  graceful fallback.
- **E2E (`playwright-cli`, per project rules):** assign the rerank model in `/settings`;
  search `"PR #835 pending"` → the 2 docs rank top with matched snippets and the noise
  tail is gone; un-assign the model → graceful fallback still returns useful (floor-
  trimmed) results; a no-match query → clean empty state.

## Open questions

None blocking. Threshold defaults are best-guess and explicitly tunable post-deploy.
