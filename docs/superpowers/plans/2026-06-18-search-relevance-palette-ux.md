# Search Relevance + Command-Palette UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make global search return relevant results in true relevance order with a visible signal — by reranking fused candidates cross-type with an absolute cutoff, dropping vector noise with a per-lane cosine floor, and rendering a unified "Top results" palette with matched-passage snippets.

**Architecture:** Reranking + cutoff live in the aggregator (`searchAll`) — one cross-type rerank call per query over a pooled candidate set, producing globally-comparable raw scores; a cheap per-lane cosine-distance floor is the always-on fallback when the reranker is unconfigured or down. The wire contract collapses to one ranked `hits` list; the client builds a "Top results" section + per-type groups from it.

**Tech Stack:** Nuxt 4 (SPA app + Nitro server) · Drizzle/pgvector (`halfvec(2560)`, HNSW cosine) · TEI embeddings + TEI `/rerank` (Qwen3-Reranker-0.6B @ `192.168.2.25:8883`) · Nuxt UI v4 `UCommandPalette`/`UDashboardSearch` · vitest.

## Global Constraints

- Package manager: **pnpm** only (never npm/yarn). Repo root: `pnpm dev`.
- Gates that must stay green: **`pnpm typecheck`**, **`pnpm test`** (vitest, `vitest run`), **`pnpm build`**. Lint is red repo-wide and is **not** a gate.
- Tests live in `test/*.test.ts`, import from `../server/...`; **pure helpers get vitest unit tests**, DB/network wiring is verified by typecheck + live E2E (the established convention — see `test/rrf.test.ts`, `test/search-providers.test.ts`, `test/chunk-collapse.test.ts`).
- `.vue` work: **Nuxt UI components + semantic design tokens only** (no raw Tailwind palette classes). Validate UI with **`playwright-cli`, not the Playwright MCP** (browser-testing skill).
- Embeddings are fixed at **2560-dim** (`halfvec(2560)`). Never change the dim.
- The reranker is **off unless a model is assigned to the `rerank` usage** in `/settings` (AI config registry, `resolveChain('rerank')`). All reranker code paths must degrade gracefully when it is unconfigured or fails — search never throws because of it.
- Search is **read-only** — no `publishChange` / live-bus emits are involved.
- Cosine distance semantics (pgvector `<=>`, normalized vectors): `0` = identical, `1` = orthogonal, `2` = opposite. A "floor" is the **max distance kept** (drop candidates with `distance > floor`).

---

## File Structure

**Create:**
- `server/lib/search/config.ts` — `SearchRelevanceConfig`, `DEFAULTS`, `mergeSearchConfig`, `getSearchConfig` (mirrors `server/lib/chunking/config.ts`).
- `server/lib/search/snippet.ts` — pure `makeSnippet(text, query, maxLen)`.
- `server/lib/search/rank.ts` — `Candidate` type + pure `rankCandidates(candidates, rerankScores, cfg)`.
- `app/utils/highlight.ts` — pure `highlightTokens(text, query)` → segments (client-rendered).
- `test/rerank.test.ts`, `test/search-config.test.ts`, `test/search-snippet.test.ts`, `test/search-rank.test.ts`, `test/highlight.test.ts`.

**Modify:**
- `server/lib/ai/rerank.ts` — return RAW scores (drop min-max); add pure `parseRerankResponse`; throw on failure.
- `server/services/memory.ts` — update the `searchMemories` rerank call-site to the new raw-score shape.
- `server/lib/chunking/collapse.ts` — add `collapseChunksToHits` (keeps min distance per source).
- `server/services/documents.ts` — `searchDocs` vector lane: cosine floor via `collapseChunksToHits`.
- `server/services/images.ts` — `searchImages` summary-vector + OCR-chunk lanes: cosine floor.
- `server/services/session-search.ts` — `searchSessions` + `searchMessages` vector lanes: cosine floor.
- `shared/types/search.ts` — add `SearchHit`/`SearchHitType`; `SearchResults` → `{ hits, reranked }`; drop the now-unused per-type Result interfaces (keep `SessionResult`/`MessageResult`).
- `server/services/search.ts` — rewrite `searchAll` (candidate producers → pool → one rerank → `rankCandidates` → `{ hits, reranked }`).
- `server/api/search.get.ts` — empty result `{ hits: [], reranked: false }`.
- `app/components/AppSearch.client.vue` — Option-A palette (Top results + type groups via slots, highlighted snippets, score badges when `reranked`).
- `test/chunk-collapse.test.ts` — add `collapseChunksToHits` cases.

---

## Task 1: Spike — verify the reranker rig contract

**Files:** none (investigative). The riskiest assumption (spec §Risks) goes first.

`rerank.ts` posts to `${baseUrl}/rerank` with `{ model, query, documents, return_documents:false }` and expects `{ results: [{ index, relevance_score }] }`. Confirm `192.168.2.25:8883` actually serves that TEI shape before building on it.

- [ ] **Step 1: Probe the rig directly**

Run (the rig is LAN-only; this env may or may not reach it):
```bash
curl -sS -m 8 -X POST http://192.168.2.25:8883/rerank \
  -H 'Content-Type: application/json' \
  -d '{"query":"deploy runbook","documents":["the deploy runbook covers rollback","an unrelated cat photo"],"return_documents":false}' \
  | head -c 2000; echo
```
Expected (TEI rerank): a JSON array or `{results:[...]}` with one entry per document, each having an `index` and a `relevance_score` (a number, typically 0..1), the relevant doc scoring higher.

- [ ] **Step 2: Record the finding + branch**

- If the response matches `{ results: [{ index, relevance_score }] }` (or a bare array of those): contract confirmed — `parseRerankResponse` (Task 2) handles it; **no adapter change needed**.
- If it differs (e.g. `scores: number[]`, or a different field name): note the actual shape here in the plan, and Task 2's `parseRerankResponse` is written to that shape instead.
- If the rig is **unreachable from this environment**: record "deferred to E2E (Task 10)". This is acceptable — every reranker path degrades gracefully (Global Constraints), so a wrong-shape rig only means the fallback path runs until Task 10 confirms/fixes the adapter against the live rig.

No commit (investigative; the finding is captured in the handover).

---

## Task 2: `rerank.ts` raw-score refactor + memory call-site

**Files:**
- Modify: `server/lib/ai/rerank.ts`
- Modify: `server/services/memory.ts:454-467`
- Test: `test/rerank.test.ts`

**Interfaces:**
- Produces: `parseRerankResponse(raw: unknown, ids: string[]): RerankResult[]` (sorted desc by raw score); `rerank(query, docs, baseUrl, apiKey, model?): Promise<RerankResult[]>` where `RerankResult = { id: string; score: number }` and `score` is the **raw** `relevance_score`. `rerank` **throws** on network/parse failure (callers decide the fallback).

- [ ] **Step 1: Write the failing test**

Create `test/rerank.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseRerankResponse } from '../server/lib/ai/rerank'

describe('parseRerankResponse', () => {
  const ids = ['a', 'b', 'c']
  it('maps results[].{index,relevance_score} → {id,score} sorted desc by raw score', () => {
    const raw = { results: [
      { index: 0, relevance_score: 0.10 },
      { index: 1, relevance_score: 0.90 },
      { index: 2, relevance_score: 0.40 }
    ] }
    expect(parseRerankResponse(raw, ids)).toEqual([
      { id: 'b', score: 0.90 },
      { id: 'c', score: 0.40 },
      { id: 'a', score: 0.10 }
    ])
  })
  it('keeps raw scores (no min-max normalisation)', () => {
    const raw = { results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.5 }] }
    const out = parseRerankResponse(raw, ['x', 'y'])
    expect(out[0]).toEqual({ id: 'x', score: 0.7 })   // top is NOT forced to 1.0
    expect(out[1]).toEqual({ id: 'y', score: 0.5 })   // bottom is NOT forced to 0.0
  })
  it('tolerates a bare array and out-of-range indices', () => {
    expect(parseRerankResponse([{ index: 1, relevance_score: 0.3 }], ['a', 'b']))
      .toEqual([{ id: 'b', score: 0.3 }])
    expect(parseRerankResponse({ results: [{ index: 9, relevance_score: 0.9 }] }, ['a']))
      .toEqual([])  // index 9 has no id → dropped
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run test/rerank.test.ts`
Expected: FAIL — `parseRerankResponse` is not exported.

- [ ] **Step 3: Rewrite `server/lib/ai/rerank.ts`**

Replace the whole file:
```ts
/**
 * Optional cross-encoder reranker (TEI /rerank).
 *
 * Disabled unless a model is assigned to the 'rerank' usage in the AI config
 * registry (Settings). The caller resolves baseURL/apiKey/model and skips
 * reranking when the usage is unconfigured.
 *
 * Returns RAW relevance scores (no normalisation) so callers can apply an
 * absolute cutoff. THROWS on network/parse failure — callers choose the fallback.
 */

export interface RerankDoc { id: string; text: string }
export interface RerankResult { id: string; score: number }

/** Pure: map a TEI /rerank response to {id,score}[] sorted desc by raw score. */
export function parseRerankResponse(raw: unknown, ids: string[]): RerankResult[] {
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : null)
  if (!arr) throw new Error(`Unexpected rerank response shape: ${JSON.stringify(raw)}`)
  const out: RerankResult[] = []
  for (const r of arr as Array<{ index?: number; relevance_score?: number }>) {
    const id = typeof r.index === 'number' ? ids[r.index] : undefined
    if (id === undefined || typeof r.relevance_score !== 'number') continue
    out.push({ id, score: r.relevance_score })
  }
  return out.sort((a, b) => b.score - a.score)
}

export async function rerank(
  query: string,
  docs: RerankDoc[],
  baseUrl: string,
  apiKey: string,
  model = 'Qwen3-Reranker-0.6B'
): Promise<RerankResult[]> {
  if (!docs.length) return []
  const raw = await $fetch(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: { model, query, documents: docs.map(d => d.text), return_documents: false },
    timeout: 5000
  })
  return parseRerankResponse(raw, docs.map(d => d.id))
}
```

- [ ] **Step 4: Update the `searchMemories` call-site in `server/services/memory.ts`**

The block at lines 448-469 calls `rerank` and remaps `relevance`. `rerank` now returns raw scores and may throw — the existing `try/catch` already handles a throw (falls back to RRF order). Update only the inner mapping so the displayed `relevance` uses the raw score:
```ts
  // Optional: reranker (OFF by default — a 'rerank' model must be assigned in config)
  let rerankCfg: { baseURL: string; apiKey: string; model: string } | null = null
  try {
    const [m] = await resolveChain('rerank')
    if (m?.baseURL) rerankCfg = { baseURL: m.baseURL.replace(/\/$/, ''), apiKey: m.apiKey ?? '', model: m.modelId }
  } catch { rerankCfg = null }  // AiNotConfiguredError → rerank stays off
  if (rerankCfg) {
    try {
      const docs = withRelevance.map(dto => ({ id: dto.id, text: dto.content }))
      const reranked = await rerank(q, docs, rerankCfg.baseURL, rerankCfg.apiKey, rerankCfg.model)
      if (reranked.length) {
        const rerankedById = new Map(reranked.map(r => [r.id, r.score]))
        return withRelevance
          .map(dto => ({ ...dto, relevance: rerankedById.get(dto.id) ?? dto.relevance }))
          .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      }
    } catch (err) {
      console.warn('[searchMemories] reranker failed, using RRF order:', err)
    }
  }

  return withRelevance
```
(The only change from today: the guard is `if (reranked.length)` instead of `=== withRelevance.length`, because the cutoff/drop semantics now live in the aggregator — `searchMemories` keeps all its rows and only reorders.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run test/rerank.test.ts && pnpm typecheck`
Expected: rerank tests PASS; typecheck 0 errors.

- [ ] **Step 6: Commit**
```bash
git add server/lib/ai/rerank.ts server/services/memory.ts test/rerank.test.ts
git commit -m "feat(search): rerank returns raw scores (drop min-max) + pure parseRerankResponse"
```

---

## Task 3: `search_relevance` config

**Files:**
- Create: `server/lib/search/config.ts`
- Test: `test/search-config.test.ts`

**Interfaces:**
- Produces: `interface SearchRelevanceConfig { rerankCutoff: number; cosineFloor: number; candidatesPerLane: number; maxCandidates: number }`; `mergeSearchConfig(raw): SearchRelevanceConfig`; `getSearchConfig(): Promise<SearchRelevanceConfig>`.

- [ ] **Step 1: Write the failing test**

Create `test/search-config.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mergeSearchConfig } from '../server/lib/search/config'

describe('mergeSearchConfig', () => {
  it('returns defaults for empty/null input', () => {
    expect(mergeSearchConfig(null)).toEqual({
      rerankCutoff: 0.2, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
    })
    expect(mergeSearchConfig(undefined)).toEqual(mergeSearchConfig({}))
  })
  it('overrides only provided keys', () => {
    expect(mergeSearchConfig({ rerankCutoff: 0.45, cosineFloor: 0.7 })).toEqual({
      rerankCutoff: 0.45, cosineFloor: 0.7, candidatesPerLane: 8, maxCandidates: 50
    })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run test/search-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/lib/search/config.ts`**
```ts
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export interface SearchRelevanceConfig {
  rerankCutoff: number       // raw rerank-score floor when reranking (drop below, unless lexicalExact)
  cosineFloor: number        // max cosine distance kept per vector lane (drop distance > floor)
  candidatesPerLane: number  // top-K per lane fed to the aggregator
  maxCandidates: number      // cap on the pool sent to the reranker
}

// Defaults are deliberately permissive: cosineFloor 1.0 keeps anything more
// similar than orthogonal (hides nothing before tuning); the reranker + the
// exact-match pin do the precision work. Tune down via the `search_relevance`
// settings key once the live corpus is observed (no redeploy).
const DEFAULTS: SearchRelevanceConfig = {
  rerankCutoff: 0.2, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
}
const KEY = 'search_relevance'

export function mergeSearchConfig(raw: Partial<SearchRelevanceConfig> | null | undefined): SearchRelevanceConfig {
  return { ...DEFAULTS, ...(raw ?? {}) }
}

export async function getSearchConfig(): Promise<SearchRelevanceConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return mergeSearchConfig(row?.value as Partial<SearchRelevanceConfig> | undefined)
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run test/search-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/search/config.ts test/search-config.test.ts
git commit -m "feat(search): search_relevance config key (getSearchConfig + permissive defaults)"
```

---

## Task 4: `collapseChunksToHits` (distance-aware collapse)

**Files:**
- Modify: `server/lib/chunking/collapse.ts`
- Test: `test/chunk-collapse.test.ts`

**Interfaces:**
- Produces: `collapseChunksToHits(hits: { sourceId: string; distance: number }[]): { sourceId: string; distance: number }[]` — first-seen per source (= min distance, since input is distance-ascending), order preserved.

- [ ] **Step 1: Add failing tests to `test/chunk-collapse.test.ts`**

Append:
```ts
import { collapseChunksToHits } from '../server/lib/chunking/collapse'

describe('collapseChunksToHits', () => {
  it('keeps the first-seen (min-distance) hit per source, order preserved', () => {
    const hits = [
      { sourceId: 'A', distance: 0.1 },
      { sourceId: 'B', distance: 0.2 },
      { sourceId: 'A', distance: 0.5 }, // later, worse → dropped
      { sourceId: 'C', distance: 0.3 }
    ]
    expect(collapseChunksToHits(hits)).toEqual([
      { sourceId: 'A', distance: 0.1 },
      { sourceId: 'B', distance: 0.2 },
      { sourceId: 'C', distance: 0.3 }
    ])
  })
  it('handles empty input', () => {
    expect(collapseChunksToHits([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run test/chunk-collapse.test.ts`
Expected: FAIL — `collapseChunksToHits` not exported.

- [ ] **Step 3: Add to `server/lib/chunking/collapse.ts`**

Append after `collapseChunksToSources`:
```ts
/** Like collapseChunksToSources, but carries the best (first-seen) distance per source. */
export function collapseChunksToHits(
  hits: { sourceId: string; distance: number }[]
): { sourceId: string; distance: number }[] {
  const seen = new Set<string>()
  const out: { sourceId: string; distance: number }[] = []
  for (const h of hits) {
    if (seen.has(h.sourceId)) continue
    seen.add(h.sourceId)
    out.push({ sourceId: h.sourceId, distance: h.distance })
  }
  return out
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run test/chunk-collapse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/chunking/collapse.ts test/chunk-collapse.test.ts
git commit -m "feat(search): collapseChunksToHits (distance-aware best-chunk-per-source)"
```

---

## Task 5: Per-lane cosine floor

**Files:**
- Modify: `server/services/documents.ts` (`searchDocs` vector lane, ~lines 166-180)
- Modify: `server/services/images.ts` (`searchImages` summary-vector + OCR-chunk lanes, ~lines 114-137)
- Modify: `server/services/session-search.ts` (`searchSessions` + `searchMessages` vector lanes)
- Modify: `server/services/memory.ts` (`searchMemories` vector lane, ~lines 412-425)

**Interfaces:**
- Consumes: `getSearchConfig` (Task 3), `collapseChunksToHits` (Task 4).
- Produces: no signature changes — each `search*` keeps its contract; the vector lane just drops candidates with `distance > cosineFloor`. Verified by typecheck (DB wiring) + E2E (Task 10).

This is one uniform transformation applied per vector lane: **select the distance, drop `distance > cosineFloor`, keep ids.** The floor comes from `getSearchConfig()` (cheap per-call DB read; single-user).

- [ ] **Step 1: `documents.ts` — add the import and floor the chunk lane**

Add to the imports at the top:
```ts
import { collapseChunksToHits } from '../lib/chunking/collapse'
import { getSearchConfig } from '../lib/search/config'
```
Replace the vector-lane body inside `searchDocs` (the `try { const qv = await embedOne(q) ... vectorIds = collapseChunksToSources(...)}` block):
```ts
  let vectorIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const chunkRows = await db.select({
      sourceId: chunks.sourceId,
      distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec`
    })
      .from(chunks)
      .innerJoin(documents, eq(chunks.sourceId, documents.id))
      .where(and(eq(chunks.sourceType, 'document'), live(), projectFilter))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(100)
    vectorIds = collapseChunksToHits(chunkRows)
      .filter(h => h.distance <= cosineFloor)
      .map(h => h.sourceId)
      .slice(0, 50)
  } catch (err) {
    console.warn('[searchDocs] vector lane failed, falling back to trigram-only:', err)
  }
```
Then remove the now-unused `collapseChunksToSources` import from `documents.ts` (it's replaced by `collapseChunksToHits`).

- [ ] **Step 2: `images.ts` — floor the summary-vector + OCR-chunk lanes**

Add to imports:
```ts
import { collapseChunksToHits } from '../lib/chunking/collapse'
import { getSearchConfig } from '../lib/search/config'
```
Replace the `try { const qv = await embedOne(q) ... }` block inside `searchImages`:
```ts
  let vecIds: string[] = []
  let ocrIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vecRows = await db.select({
      id: images.id,
      distance: sql<number>`${images.embedding} <=> ${lit}::halfvec`
    }).from(images)
      .where(and(live(), isNotNull(images.embedding)))
      .orderBy(sql`${images.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vecRows.filter(r => r.distance <= cosineFloor).map(r => r.id)

    const chunkRows = await db.select({
      sourceId: chunks.sourceId,
      distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec`
    })
      .from(chunks)
      .innerJoin(images, eq(chunks.sourceId, images.id))
      .where(and(eq(chunks.sourceType, 'image'), live()))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(100)
    ocrIds = collapseChunksToHits(chunkRows)
      .filter(h => h.distance <= cosineFloor)
      .map(h => h.sourceId)
      .slice(0, 50)
  } catch (err) {
    console.warn('[searchImages] vector lane failed, falling back to lexical-only:', err)
  }
```
Remove the now-unused `collapseChunksToSources` import from `images.ts`.

- [ ] **Step 3: `session-search.ts` — floor both vector lanes**

Add to imports: `import { getSearchConfig } from '../lib/search/config'`.

In `searchSessions`, replace the vector `try` block:
```ts
  let vecIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await db.select({
      id: sessions.id,
      distance: sql<number>`${sessions.summaryEmbedding} <=> ${lit}::halfvec`
    }).from(sessions)
      .where(isNotNull(sessions.summaryEmbedding))
      .orderBy(sql`${sessions.summaryEmbedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vRows.filter(r => r.distance <= cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchSessions] vector lane failed, falling back to trigram-only:', err)
  }
```
In `searchMessages`, replace the vector `try` block:
```ts
  let vecIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await db.select({
      id: messages.id,
      distance: sql<number>`${messages.embedding} <=> ${lit}::halfvec`
    }).from(messages)
      .where(isNotNull(messages.embedding))
      .orderBy(sql`${messages.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vRows.filter(r => r.distance <= cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchMessages] vector lane failed, falling back to trigram-only:', err)
  }
```

- [ ] **Step 4: `memory.ts` — floor the vector lane**

Add to imports: `import { getSearchConfig } from '../lib/search/config'`.

Replace the vector `try` block inside `searchMemories` (~lines 413-425):
```ts
  let vectorIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vecRows = await db.select({
      id: memories.id,
      distance: sql<number>`${memories.embedding} <=> ${lit}::halfvec`
    })
      .from(memories)
      .where(and(baseWhere, isNotNull(memories.embedding)))
      .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vectorIds = vecRows.filter(r => r.distance <= cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchMemories] vector lane failed, falling back to trigram-only:', err)
  }
```

- [ ] **Step 5: Typecheck + full test run**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 0; all tests pass (no behavior asserted by unit tests here — the pure helpers are already covered; this verifies the wiring compiles and nothing regressed).

- [ ] **Step 6: Commit**
```bash
git add server/services/documents.ts server/services/images.ts server/services/session-search.ts server/services/memory.ts
git commit -m "feat(search): per-lane cosine-distance floor on all vector lanes (config-driven)"
```

---

## Task 6: Snippet + highlight pure helpers

**Files:**
- Create: `server/lib/search/snippet.ts`
- Create: `app/utils/highlight.ts`
- Test: `test/search-snippet.test.ts`, `test/highlight.test.ts`

**Interfaces:**
- Produces: `makeSnippet(text: string, query: string, maxLen?: number): string`; `highlightTokens(text: string, query: string): { text: string; match: boolean }[]`.

- [ ] **Step 1: Write the failing snippet test**

Create `test/search-snippet.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeSnippet } from '../server/lib/search/snippet'

describe('makeSnippet', () => {
  it('returns a window centred on the first matched token, ellipsized', () => {
    const text = 'Intro paragraph. The deploy is blocked on PR #835 pending review and CI. Footer.'
    const s = makeSnippet(text, 'PR #835 pending', 40)
    expect(s).toContain('PR #835 pending')
    expect(s.length).toBeLessThanOrEqual(42) // maxLen + the two ellipsis chars
    expect(s.startsWith('…')).toBe(true)      // window starts mid-text
  })
  it('collapses whitespace/newlines to single spaces', () => {
    expect(makeSnippet('a\n\n  b\tc', 'b', 100)).toBe('a b c')
  })
  it('falls back to the head when no token matches', () => {
    expect(makeSnippet('hello world of text', 'zzz', 11)).toBe('hello world…')
  })
  it('returns short text unchanged', () => {
    expect(makeSnippet('short', 'short', 160)).toBe('short')
  })
  it('ignores 1-char query tokens when locating the window', () => {
    const s = makeSnippet('aaaa target bbbb', 'a target', 160)
    expect(s).toContain('target')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run test/search-snippet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/lib/search/snippet.ts`**
```ts
/** Query tokens worth locating a snippet around (drop 1-char noise). */
function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
}

/**
 * Build a display snippet: collapse whitespace, find the earliest matched query
 * token, and return a window of up to `maxLen` chars around it with `…` ellipses
 * on truncated ends. No match → the head of the text.
 */
export function makeSnippet(text: string, query: string, maxLen = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return clean

  const lower = clean.toLowerCase()
  let idx = -1
  for (const t of tokens(query)) {
    const i = lower.indexOf(t)
    if (i !== -1 && (idx === -1 || i < idx)) idx = i
  }

  if (idx === -1) return clean.slice(0, maxLen) + '…'

  const start = Math.max(0, idx - 30)
  const end = Math.min(clean.length, start + maxLen)
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}
```

- [ ] **Step 4: Run snippet test**

Run: `pnpm vitest run test/search-snippet.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing highlight test**

Create `test/highlight.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { highlightTokens } from '../app/utils/highlight'

describe('highlightTokens', () => {
  it('splits text into matched/unmatched segments (case-insensitive)', () => {
    expect(highlightTokens('Blocked on PR #835 today', 'pr')).toEqual([
      { text: 'Blocked on ', match: false },
      { text: 'PR', match: true },
      { text: ' #835 today', match: false }
    ])
  })
  it('matches multiple tokens and escapes regex specials', () => {
    const segs = highlightTokens('cost is $5 (five)', '$5 five')
    expect(segs.filter(s => s.match).map(s => s.text.toLowerCase())).toEqual(['$5', 'five'])
  })
  it('returns one unmatched segment when nothing matches', () => {
    expect(highlightTokens('hello', 'zzz')).toEqual([{ text: 'hello', match: false }])
  })
  it('handles empty text', () => {
    expect(highlightTokens('', 'x')).toEqual([])
  })
})
```

- [ ] **Step 6: Run it, verify it fails**

Run: `pnpm vitest run test/highlight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Create `app/utils/highlight.ts`**
```ts
export interface HighlightSegment { text: string; match: boolean }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Split `text` into matched/unmatched segments against the query's tokens
 * (case-insensitive, ≥2 chars). Used to render <mark>-style highlights in the
 * palette. Pure — no DOM.
 */
export function highlightTokens(text: string, query: string): HighlightSegment[] {
  if (!text) return []
  const toks = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2).map(escapeRegExp)
  if (!toks.length) return [{ text, match: false }]

  const re = new RegExp(`(${toks.join('|')})`, 'gi')
  const out: HighlightSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), match: false })
    out.push({ text: m[0], match: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false })
  return out
}
```

- [ ] **Step 8: Run both tests**

Run: `pnpm vitest run test/search-snippet.test.ts test/highlight.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**
```bash
git add server/lib/search/snippet.ts app/utils/highlight.ts test/search-snippet.test.ts test/highlight.test.ts
git commit -m "feat(search): makeSnippet + highlightTokens pure helpers"
```

---

## Task 7: Unified contract types + `rankCandidates`

**Files:**
- Modify: `shared/types/search.ts`
- Create: `server/lib/search/rank.ts`
- Test: `test/search-rank.test.ts`

**Interfaces:**
- Produces: `SearchHitType`, `SearchHit`, `SearchResults { hits: SearchHit[]; reranked: boolean }` (search.ts); `Candidate` + `rankCandidates(candidates: Candidate[], rerankScores: Map<string,number> | null, cfg: { rerankCutoff: number }): SearchHit[]` (rank.ts).
- Consumed by: Task 8 (`searchAll`), Task 9 (`AppSearch.client.vue`).

- [ ] **Step 1: Rewrite `shared/types/search.ts`**

Replace the whole file (keep `SessionResult`/`MessageResult` — `session-search.ts` imports them; drop the other per-type Result interfaces, now unused):
```ts
export type SearchHitType =
  'document' | 'memory' | 'image' | 'task' | 'project' | 'session' | 'message'

export interface SearchHit {
  type: SearchHitType
  id: string
  title: string            // primary display line
  snippet: string | null   // matched passage / excerpt (may contain the matched phrase)
  score: number            // raw rerank score (0..1) when reranked, else synthetic RRF order
  to: string               // route
  icon: string             // lucide icon name
  meta: string | null      // type-specific: doc path / memory scope / task status / session project / msg role
}

export interface SearchResults {
  hits: SearchHit[]        // globally ranked, post-cutoff
  reranked: boolean        // true when the cross-encoder produced the scores (controls score-badge display)
}

// Lane-level shapes still produced by session-search.ts and consumed by the aggregator.
export interface SessionResult {
  type: 'session'
  id: string
  title: string
  snippet: string
  project: string | null
  to: string
}

export interface MessageResult {
  type: 'message'
  id: string
  sessionId: string
  role: string | null
  snippet: string
  to: string
}
```

- [ ] **Step 2: Write the failing `rankCandidates` test**

Create `test/search-rank.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { rankCandidates, type Candidate } from '../server/lib/search/rank'

const c = (over: Partial<Candidate>): Candidate => ({
  type: 'document', id: 'x', title: 'X', snippet: null, to: '/x', icon: 'i',
  meta: null, rerankText: 'x', lexicalExact: false, rrfRank: 0, ...over
})

describe('rankCandidates', () => {
  it('with rerank scores: sorts desc and drops below cutoff', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' }), c({ id: 'c' })]
    const scores = new Map([['document:a', 0.9], ['document:b', 0.1], ['document:c', 0.5]])
    const hits = rankCandidates(cands, scores, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['a', 'c'])           // b (0.1) dropped
    expect(hits[0]).toMatchObject({ id: 'a', score: 0.9 })
  })
  it('pins exact lexical matches even below cutoff', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b', lexicalExact: true })]
    const scores = new Map([['document:a', 0.9], ['document:b', 0.01]])
    const hits = rankCandidates(cands, scores, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['a', 'b'])           // b kept (pinned), ranked last
  })
  it('returns [] when nothing clears the cutoff and nothing is pinned', () => {
    const cands = [c({ id: 'a' }), c({ id: 'b' })]
    const scores = new Map([['document:a', 0.05], ['document:b', 0.02]])
    expect(rankCandidates(cands, scores, { rerankCutoff: 0.3 })).toEqual([])
  })
  it('fallback (no scores): orders by reciprocal lane rank, exact matches lead, keeps all', () => {
    const cands = [
      c({ id: 'a', rrfRank: 0 }),
      c({ id: 'b', rrfRank: 2, lexicalExact: true }),
      c({ id: 'c', rrfRank: 1 })
    ]
    const hits = rankCandidates(cands, null, { rerankCutoff: 0.3 })
    expect(hits.map(h => h.id)).toEqual(['b', 'a', 'c'])      // b boosted by lexicalExact
    expect(hits).toHaveLength(3)
  })
  it('strips internal fields from the returned SearchHit', () => {
    const hit = rankCandidates([c({ id: 'a' })], null, { rerankCutoff: 0.3 })[0]
    expect(Object.keys(hit).sort()).toEqual(['icon', 'id', 'meta', 'score', 'snippet', 'title', 'to', 'type'])
  })
})
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm vitest run test/search-rank.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `server/lib/search/rank.ts`**
```ts
import type { SearchHit, SearchHitType } from '../../../shared/types/search'

export interface Candidate {
  type: SearchHitType
  id: string
  title: string
  snippet: string | null
  to: string
  icon: string
  meta: string | null
  rerankText: string     // text fed to the cross-encoder
  lexicalExact: boolean  // matched an exact substring → never dropped by the cutoff
  rrfRank: number        // 0-based position within its lane (fallback ordering)
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Rank candidates into the final SearchHit list.
 *
 * - rerankScores present → score = raw cross-encoder score; drop below cutoff
 *   UNLESS lexicalExact (exact substring matches are pinned). Sort desc.
 * - rerankScores null (reranker off/failed) → synthetic score = reciprocal lane
 *   rank + a boost for exact matches; NO cutoff (the per-lane cosine floor
 *   already trimmed weak vector hits). Sort desc.
 */
export function rankCandidates(
  candidates: Candidate[],
  rerankScores: Map<string, number> | null,
  cfg: { rerankCutoff: number }
): SearchHit[] {
  const key = (c: Candidate) => `${c.type}:${c.id}`

  const scored = rerankScores
    ? candidates
        .map(c => ({ c, score: rerankScores.get(key(c)) ?? 0 }))
        .filter(({ c, score }) => c.lexicalExact || score >= cfg.rerankCutoff)
    : candidates.map(c => ({ c, score: (c.lexicalExact ? 1 : 0) + 1 / (1 + c.rrfRank) }))

  scored.sort((a, b) => b.score - a.score)

  return scored.map(({ c, score }) => ({
    type: c.type, id: c.id, title: c.title, snippet: c.snippet,
    score: round3(score), to: c.to, icon: c.icon, meta: c.meta
  }))
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm vitest run test/search-rank.test.ts && pnpm typecheck`
Expected: rank tests PASS. **Typecheck WILL fail** in `server/services/search.ts` / `search.get.ts` / `AppSearch.client.vue` because `SearchResults` changed shape — that is expected and fixed in Tasks 8–9. Confirm the ONLY typecheck errors are in those three files; fix any others.

- [ ] **Step 6: Commit**
```bash
git add shared/types/search.ts server/lib/search/rank.ts test/search-rank.test.ts
git commit -m "feat(search): unified SearchHit contract + pure rankCandidates (cutoff + exact-pin)"
```

---

## Task 8: Aggregator rewrite (`searchAll`)

**Files:**
- Modify: `server/services/search.ts` (full rewrite of `searchAll`)
- Modify: `server/api/search.get.ts`
- Test: typecheck (DB/network wiring; behavior covered by Tasks 6–7 helpers + E2E in Task 10)

**Interfaces:**
- Consumes: `searchDocs`, `searchPassages` (documents.ts), `searchMemories`, `searchImages`, `searchSessions`, `searchMessages`, `getSearchConfig`, `rerank`, `resolveChain`, `makeSnippet`, `rankCandidates`/`Candidate`.
- Produces: `searchAll(q): Promise<SearchResults>` returning `{ hits, reranked }`.

- [ ] **Step 1: Rewrite `server/services/search.ts`**

Replace the whole file:
```ts
import { and, isNull, ilike, or } from 'drizzle-orm'
import { useDb } from '../db'
import { tasks, projects } from '../db/schema'
import { searchDocs, searchPassages } from './documents'
import { searchMemories } from './memory'
import { searchImages } from './images'
import { searchSessions, searchMessages } from './session-search'
import { getSearchConfig } from '../lib/search/config'
import { makeSnippet } from '../lib/search/snippet'
import { rankCandidates, type Candidate } from '../lib/search/rank'
import { rerank } from '../lib/ai/rerank'
import { resolveChain } from '../lib/ai/registry/resolve'
import type { SearchResults } from '../../shared/types/search'

const RERANK_TEXT_MAX = 512
const clip = (s: string) => (s.length > RERANK_TEXT_MAX ? s.slice(0, RERANK_TEXT_MAX) : s)
const includesCI = (haystack: string, q: string) => haystack.toLowerCase().includes(q.toLowerCase())

export async function searchAll(q: string): Promise<SearchResults> {
  if (!q.trim()) return { hits: [], reranked: false }
  const cfg = await getSearchConfig()
  const K = cfg.candidatesPerLane

  const [docC, memC, imgC, taskC, projC, sessC, msgC] = await Promise.all([
    // documents — best chunk passage as snippet + rerank text
    (async (): Promise<Candidate[]> => {
      try {
        const [docs, passages] = await Promise.all([searchDocs(q), searchPassages(q, { limit: K })])
        const bestPassage = new Map<string, string>()
        for (const p of passages) if (!bestPassage.has(p.sourceId)) bestPassage.set(p.sourceId, p.content)
        return docs.slice(0, K).map((d, i): Candidate => {
          const body = bestPassage.get(d.id) ?? d.content
          return {
            type: 'document', id: d.id, title: d.title || d.path, to: '/documents?doc=' + d.id,
            icon: 'i-lucide-file-text', meta: d.path,
            snippet: makeSnippet(body, q), rerankText: clip(`${d.title ?? ''}\n${body}`),
            lexicalExact: includesCI(`${d.title ?? ''} ${d.content}`, q), rrfRank: i
          }
        })
      } catch { return [] }
    })(),

    // memories
    (async (): Promise<Candidate[]> => {
      try {
        const mems = await searchMemories(q, { limit: K })
        return mems.map((m, i): Candidate => ({
          type: 'memory', id: m.id, title: makeSnippet(m.content, q, 80), to: '/memories',
          icon: 'i-lucide-brain', meta: m.scope,
          snippet: makeSnippet(m.content, q), rerankText: clip(m.content),
          lexicalExact: includesCI(m.content, q), rrfRank: i
        }))
      } catch { return [] }
    })(),

    // images — summary + OCR text
    (async (): Promise<Candidate[]> => {
      try {
        const imgs = await searchImages(q)
        return imgs.slice(0, K).map((im, i): Candidate => {
          const body = `${im.summary ?? ''}\n${im.ocrText ?? ''}`.trim()
          const tagStr = (im.tags ?? []).join(', ')
          return {
            type: 'image', id: im.id, title: tagStr || im.originalName || 'Image', to: '/gallery',
            icon: 'i-lucide-image', meta: null,
            snippet: makeSnippet(body || tagStr, q), rerankText: clip(body || tagStr),
            lexicalExact: includesCI(`${body} ${tagStr}`, q), rrfRank: i
          }
        })
      } catch { return [] }
    })(),

    // tasks — ILIKE (always an exact lexical match)
    (async (): Promise<Candidate[]> => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(tasks)
          .where(and(isNull(tasks.deletedAt), or(ilike(tasks.title, pattern), ilike(tasks.description, pattern))))
          .limit(K)
        return rows.map((t, i): Candidate => ({
          type: 'task', id: t.id, title: t.title, to: '/tasks', icon: 'i-lucide-square-kanban', meta: t.status,
          snippet: makeSnippet(t.description || t.title, q), rerankText: clip(`${t.title}\n${t.description ?? ''}`),
          lexicalExact: true, rrfRank: i
        }))
      } catch { return [] }
    })(),

    // projects — ILIKE (always exact)
    (async (): Promise<Candidate[]> => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(projects)
          .where(or(ilike(projects.name, pattern), ilike(projects.slug, pattern)))
          .limit(K)
        return rows.map((p, i): Candidate => ({
          type: 'project', id: p.slug, title: p.name, to: '/projects', icon: 'i-lucide-folder-kanban', meta: p.slug,
          snippet: null, rerankText: clip(`${p.name} ${p.slug}`), lexicalExact: true, rrfRank: i
        }))
      } catch { return [] }
    })(),

    // sessions
    (async (): Promise<Candidate[]> => {
      try {
        const sess = await searchSessions(q, K)
        return sess.map((s, i): Candidate => ({
          type: 'session', id: s.id, title: s.title, to: s.to, icon: 'i-lucide-history', meta: s.project,
          snippet: makeSnippet(s.snippet, q), rerankText: clip(`${s.title}\n${s.snippet}`),
          lexicalExact: includesCI(`${s.title} ${s.snippet}`, q), rrfRank: i
        }))
      } catch { return [] }
    })(),

    // messages
    (async (): Promise<Candidate[]> => {
      try {
        const msgs = await searchMessages(q, K)
        return msgs.map((m, i): Candidate => ({
          type: 'message', id: m.id, title: makeSnippet(m.snippet, q, 80), to: m.to,
          icon: 'i-lucide-message-circle', meta: m.role,
          snippet: makeSnippet(m.snippet, q), rerankText: clip(m.snippet),
          lexicalExact: includesCI(m.snippet, q), rrfRank: i
        }))
      } catch { return [] }
    })()
  ])

  const pool = [...docC, ...memC, ...imgC, ...taskC, ...projC, ...sessC, ...msgC].slice(0, cfg.maxCandidates)
  if (pool.length === 0) return { hits: [], reranked: false }

  // Single cross-type rerank → raw scores (only if a 'rerank' model is assigned)
  let rerankScores: Map<string, number> | null = null
  let rerankModel: { baseURL: string | null; apiKey: string | null; modelId: string } | null = null
  try {
    const [m] = await resolveChain('rerank')
    if (m?.baseURL) rerankModel = m
  } catch { rerankModel = null }  // AiNotConfiguredError → reranker off

  if (rerankModel?.baseURL) {
    try {
      const docs = pool.map(c => ({ id: `${c.type}:${c.id}`, text: c.rerankText }))
      const results = await rerank(q, docs, rerankModel.baseURL.replace(/\/$/, ''), rerankModel.apiKey ?? '', rerankModel.modelId)
      rerankScores = new Map(results.map(r => [r.id, r.score]))
    } catch (err) {
      console.warn('[searchAll] reranker failed, falling back to RRF order:', err)
      rerankScores = null
    }
  }

  const hits = rankCandidates(pool, rerankScores, { rerankCutoff: cfg.rerankCutoff })
  return { hits, reranked: rerankScores !== null }
}
```

- [ ] **Step 2: Update `server/api/search.get.ts`**

Replace the file:
```ts
import { searchAll } from '../services/search'
import type { SearchResults } from '../../shared/types/search'

const emptyResults: SearchResults = { hits: [], reranked: false }

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  if (typeof q !== 'string' || !q.trim() || q.length > 200) return emptyResults
  return searchAll(q.trim())
})
```

- [ ] **Step 3: Typecheck + full test run**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck errors now ONLY in `app/components/AppSearch.client.vue` (fixed in Task 9). All vitest tests pass.

- [ ] **Step 4: Commit**
```bash
git add server/services/search.ts server/api/search.get.ts
git commit -m "feat(search): cross-type rerank + cutoff in searchAll → unified hits contract"
```

---

## Task 9: Palette UI — Option A

**Files:**
- Modify: `app/components/AppSearch.client.vue`
- Validation: `playwright-cli` (Task 10)

**Interfaces:**
- Consumes: `SearchResults`/`SearchHit` (search.ts), `highlightTokens` (app/utils/highlight.ts), `useGlobalSearch`.

Before editing: invoke the **nuxt-ui-docs** skill if any `UCommandPalette` slot/prop detail is uncertain (our v4 API). Build the groups from one ranked `hits` list: a `top` group (first `TOP_COUNT` hits) + per-type groups (bucket by `type`, omit empties). Render snippet + highlight via the global `#item-label` slot; render a score `UBadge` via `#item-trailing` only when `results.reranked`.

- [ ] **Step 1: Rewrite `app/components/AppSearch.client.vue`**
```vue
<script setup lang="ts">
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { SearchResults, SearchHit, SearchHitType } from '~~/shared/types/search'
import { highlightTokens } from '~/utils/highlight'

const { search } = useGlobalSearch()

const TOP_COUNT = 6
const searchTerm = ref('')
const results = ref<SearchResults | null>(null)
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(searchTerm, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q.trim()) { results.value = null; loading.value = false; return }
  loading.value = true
  debounceTimer = setTimeout(async () => {
    try { results.value = await search(q.trim()) } catch { results.value = null }
    finally { loading.value = false }
  }, 250)
})
onUnmounted(() => { if (debounceTimer) clearTimeout(debounceTimer) })

// Item carries the hit so the slot can render snippet + highlight + score.
type HitItem = CommandPaletteItem & { hit: SearchHit }
const toItem = (h: SearchHit): HitItem => ({
  id: `${h.type}:${h.id}`,
  label: h.title,
  icon: h.icon,
  slot: 'hit' as const,
  hit: h,
  onSelect: () => navigateTo(h.to)
})

const TYPE_LABELS: Record<SearchHitType, string> = {
  document: 'Documents', memory: 'Memories', image: 'Images', task: 'Tasks',
  project: 'Projects', session: 'Sessions', message: 'Messages'
}
const TYPE_ORDER: SearchHitType[] = ['document', 'memory', 'image', 'task', 'project', 'session', 'message']

const groups = computed<CommandPaletteGroup<HitItem>[]>(() => {
  const hits = results.value?.hits ?? []
  if (!hits.length) return []
  const list: CommandPaletteGroup<HitItem>[] = []

  list.push({
    id: 'top', label: 'Top results', ignoreFilter: true,
    items: hits.slice(0, TOP_COUNT).map(toItem)
  })
  for (const type of TYPE_ORDER) {
    const items = hits.filter(h => h.type === type).map(toItem)
    if (items.length) list.push({ id: type, label: TYPE_LABELS[type], ignoreFilter: true, items })
  }
  return list
})

const showScore = computed(() => results.value?.reranked === true)
</script>

<template>
  <UDashboardSearch
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    title="Search"
    description="Search documents, memories, images, tasks, projects, sessions and messages"
    placeholder="Search everything…"
    :color-mode="false"
  >
    <template #hit-label="{ item }">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="truncate text-highlighted">{{ item.hit.title }}</span>
        <span v-if="item.hit.snippet" class="truncate text-xs text-muted">
          <template v-for="(seg, i) in highlightTokens(item.hit.snippet, searchTerm)" :key="i">
            <mark v-if="seg.match" class="bg-primary/15 text-highlighted rounded-[2px]">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
      </div>
    </template>
    <template #hit-trailing="{ item }">
      <UBadge v-if="showScore" :label="item.hit.score.toFixed(2)" color="neutral" variant="subtle" size="sm" />
    </template>
  </UDashboardSearch>
</template>
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: typecheck 0 errors; build succeeds. (If a slot name or `CommandPaletteGroup` generic fights the types, consult nuxt-ui-docs; the roll-our-own escape hatch from the spec applies only if a slot is genuinely unsupported.)

- [ ] **Step 3: Commit**
```bash
git add app/components/AppSearch.client.vue
git commit -m "feat(search): Option-A palette — Top results + type groups, snippets, score badges"
```

---

## Task 10: Live E2E validation + wiki + handover

**Files:**
- Modify: `docs/wiki/search.md`
- Create: `docs/handovers/2026-06-18-search-relevance-palette-ux.md`
- Validation: `playwright-cli` (browser-testing skill) against `pnpm dev` with the real rigs

**Interfaces:** none (validation + docs).

- [ ] **Step 1: Confirm/assign the reranker, then run the dev server**

In `/settings` → AI config, assign a model to the **`rerank`** usage pointing at the rig confirmed in Task 1 (`http://192.168.2.25:8883`, model `Qwen3-Reranker-0.6B`). Then `pnpm dev`.

- [ ] **Step 2: E2E — reranked relevance (browser-testing skill, playwright-cli)**

Log in (dev creds from the browser-testing skill). Open the ⌘K palette, search `PR #835 pending`. Assert:
- the 2 known docs appear in **Top results**, ranked first, each with a **matched snippet** containing the phrase (highlighted);
- the previous irrelevant tail (random docs/memories) is **gone**;
- a score badge shows on each hit (reranked mode).
Capture a screenshot.

- [ ] **Step 3: E2E — graceful fallback**

In `/settings`, **un-assign** the `rerank` model. Re-run the same search. Assert: results still return (cosine-floor-trimmed RRF order), exact matches still lead, **no score badges** (`reranked:false`), no errors in console/network. Then re-assign the model.

- [ ] **Step 4: E2E — empty state**

Search a string with no plausible match (e.g. `zzzqqxnomatch`). Assert: the palette shows a clean "no results" state (no padded noise).

- [ ] **Step 5: Tune thresholds if needed**

If Step 2 hid a real match or kept noise, adjust the `search_relevance` settings key (`rerankCutoff` / `cosineFloor`) — via the settings store — and re-test. Record the chosen values in the handover.

- [ ] **Step 6: Update `docs/wiki/search.md`**

Rewrite the Palette + aggregator sections to current behaviour: cross-type single-rerank in `searchAll`; per-lane cosine floor; unified `hits` + `reranked` contract; Option-A palette (Top results + type groups, snippets, score badges); `search_relevance` config key; reranker enabled via the `rerank` usage assignment. Move the "reranker off by default" follow-up to "shipped." Bump `updated:`.

- [ ] **Step 7: Write the handover**

Create `docs/handovers/2026-06-18-search-relevance-palette-ux.md` with accurate frontmatter (title/cycle 32/date/status/branch/spec/plan/wiki + a `shipped:` list), the Task-1 rig finding, the chosen threshold values, gate results (typecheck/test/build), the E2E outcomes, and deferred follow-ons (MCP-side reranking; embed-q-once optimization; contextual BM25; a `/settings` relevance-tuning UI tab).

- [ ] **Step 8: Final gates + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green.
```bash
git add docs/wiki/search.md docs/handovers/2026-06-18-search-relevance-palette-ux.md
git commit -m "docs(search): cycle-32 wiki + handover — search relevance + palette UX"
```

---

## Self-Review

**Spec coverage:**
- Cross-type rerank in aggregator → Task 8. ✅
- Absolute cutoff on raw scores + exact-match pin → Task 7 (`rankCandidates`), raw scores → Task 2. ✅
- Per-lane cosine floor (always-on fallback) → Tasks 4–5. ✅
- Graceful degradation (reranker off/fails) → Task 8 (`resolveChain` guard + try/catch → null scores) + Task 7 fallback branch. ✅
- Empty state when nothing clears the bar → Task 7 (returns `[]`) + Task 9 (palette empty). ✅
- Unified `hits` contract → Task 7. ✅
- Snippets + highlight → Task 6; doc snippet = best chunk passage → Task 8 (`searchPassages` join). ✅
- Option-A palette on `UCommandPalette` via slots → Task 9. ✅
- `search_relevance` config key → Task 3; reranker enable via existing `/settings` → Task 10 Step 1. ✅
- Risk: rig endpoint spike → Task 1. ✅ Threshold tuning → Task 10 Step 5. ✅
- Out-of-scope (MCP reranking, BM25, settings UI tab) → noted in Task 10 handover. ✅

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has expected output. ✅

**Type consistency:** `SearchHit`/`SearchResults { hits, reranked }` defined in Task 7 and consumed identically in Tasks 8–9; `Candidate` defined in Task 7, produced in Task 8; `RerankResult { id, score }` from Task 2 used in Task 8; `collapseChunksToHits` signature (Task 4) matches its use in Task 5; `getSearchConfig`/`SearchRelevanceConfig` (Task 3) used in Tasks 5 & 8; `makeSnippet`/`highlightTokens` (Task 6) used in Tasks 8 & 9. ✅
