---
title: Search + Command Palette
status: shipped
cycle: 8 (extended 13, 20, 31, 32, 33)
updated: 2026-06-19
---

# Search + Command Palette

A global ⌘K command palette that searches every surface, ranks results across
types by true relevance, and shows the matching passage per hit.

## Aggregator — `server/services/search.ts`
`searchAll(q)` (cycle 32) fans out the lanes in parallel, turns each into
**candidates**, optionally reranks the whole pool **cross-type in one call**, applies
a relevance cutoff, and returns **one globally-ranked list**:

```
searchAll(q):
  1. 7 lanes in parallel, each try/caught (a lane failure → [], never tanks search),
     each → Candidate[] { type,id,title,to,icon,meta, snippet, rerankText, lexicalExact, rrfRank }
       - vector lanes drop candidates past the COSINE FLOOR before returning (always-on)
       - doc snippet/rerankText = best-matching chunk passage (searchPassages) ?? doc content
       - lexicalExact = the query is an exact substring of the candidate's text
  2. pool = all candidates, capped at maxCandidates
  3. rank (rankCandidates):
       if a `rerank` model is assigned (resolveChain('rerank')):
          ONE rerank(q, pool) → RAW scores; sort desc; keep score >= rerankRelBand × topScore
          (a per-query RELATIVE band, robust to the length-dependent scale) OR lexicalExact
          (pinned — a known phrase always survives)
       else (unconfigured / threw / empty result): synthetic RRF-rank score, sort desc, no band
       cap to rerankTopK
  4. return { hits, reranked }     // reranked = scores actually came from the reranker
```

| Lane | Backing | Match |
|---|---|---|
| documents | `searchDocs(q)` + `searchPassages(q)` | hybrid trigram + **chunk**-vector (RRF, best-chunk snippet) |
| memories | `searchMemories(q)` | hybrid + own reranker hook (independent) |
| images | `searchImages(q)` | hybrid lexical + summary-vector + OCR-chunk-vector (RRF) |
| sessions | session search | semantic (session-summary vector, RRF) |
| messages | message search | semantic (message vector, RRF) |
| tasks | `listTasks` | title/description ILIKE (always `lexicalExact`) |
| projects | `listProjects` | name/slug ILIKE (always `lexicalExact`) |

`GET /api/search?q=` (auth-gated; blank / over-200-char `q` → `{ hits: [], reranked: false }`)
returns `SearchResults = { hits: SearchHit[]; reranked: boolean }` (`shared/types/search.ts`).
`SearchHit = { type, id, title, snippet, score, to, icon, meta }`. All ILIKE queries are
drizzle-parameterized; the embedding literal is a bound `::halfvec` param (no injection).

### Relevance pieces (cycle 32)
- **Reranker** (`server/lib/ai/rerank.ts`): a `/rerank` cross-encoder client. Returns **raw**
  scores (the legacy `/rerank` field is `score`; the Cohere `/v1`–`/v2` routes return the same
  numbers as `relevance_score` — both parsed; the `model` field is ignored by the rig shim).
  No min-max — the raw scores feed the **per-query relative band** (cycle 33). Resolved from the
  AI-config registry via `resolveChain('rerank')`; **OFF until a model is assigned to the
  `rerank` usage** in `/settings/model-config`. Never blocks search (throws → fall back to RRF order; an
  empty result set also falls back).
- **Cutoff = top-k + relative band** (cycle 33, `rankCandidates` in `server/lib/search/rank.ts`):
  reranked candidates are sorted, then kept iff `lexicalExact || score >= rerankRelBand × topScore`,
  then capped to `rerankTopK`. Relative to the query's own top hit → robust to the reranker's
  **length-dependent** absolute scale (a fixed absolute floor over/under-trimmed by passage
  length). Fallback (no reranker) = synthetic RRF rank, capped to `rerankTopK`, no band. Empty
  state is **retrieval-based** — a non-empty pool always yields ≥1 hit, so `hits=[]` ⟺ the lanes
  returned nothing (we don't score-gate emptiness; gibberish queries score high).
- **Cosine floor** (per vector lane): drops nearest-neighbours past `cosineFloor` cosine
  distance before fusion — the always-on noise trim when the reranker is off/down.
- **Config** — `server/lib/search/config.ts`, `search_relevance` settings key (JSONB) over
  defaults `{ rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8,
  maxCandidates: 50 }`. Tunable without redeploy. `rerankRelBand 0.6` keeps hits within 60% of
  the top score (relevant lands ~1.0 on the current model); `cosineFloor 1.0` is permissive
  (hides nothing) — tune on a real corpus.
- **Snippet + highlight** — `makeSnippet(text,q)` (server, window around the matched token)
  + `highlightTokens(text,q)` (client, `<mark>` segments).

> **Chunking (cycle 31):** the document + image vector lanes search a per-chunk `chunks`
> index (best-chunk-per-source collapse) with contextual-prefix embeddings. Chunk-level
> passages for agents: `searchPassages` / the MCP `search_passages` tool. See [`chunking.md`](chunking.md).

## Palette — `app/components/AppSearch.client.vue`
`UDashboardSearchButton` (above Capture) + `UDashboardSearch` (⌘K), debounced query →
`/api/search`, the `hits` list mapped into command groups (cycle 32, Option A):
- a **"Top results"** group — the top ~6 hits across all types, each: type icon + title +
  highlighted matched **snippet** (`#hit-label` slot) + a **score badge** (`#hit-trailing`,
  shown only when `reranked`);
- then **per-type groups**, bucketed from the same `hits`, score-ordered, **empty groups
  omitted**;
- `onSelect` → `navigateTo(hit.to)` (document → `/documents?doc=<id>`, session → `/sessions/<id>`, …).
- No hits → the palette's empty state.

## Rendering note (cycle 8)
The app is a **SPA** (`routeRules '/**': { ssr:false }`, global `ssr` stays `true`); only
`/share/**` is SSR. New pages are SPA by default via the catch-all.

## Operational note — reranker (cycle 32 → corrected 2026-06-19 → mxbai + relative cutoff, cycle 33)
The reranker is wired, **OFF until a model is assigned**, and now in good shape:

- **Cohere shim, fully compatible.** Client posts `{ model, query, documents }` and reads
  `relevance_score` || `score`; `/rerank`, `/v1/rerank`, `/v2/rerank` return identical scores
  (point the provider `baseURL` at the prefix — bare → `/rerank`, `…/v2` → `/v2/rerank`). The
  **`model` field is ignored** by the shim (the loaded model is fixed by its own config) — cosmetic.
- **Model: `mixedbread-ai/mxbai-rerank-large-v2`** (1.5B, fp16, ~2.5 GB) replaced the 0.6B, which
  *inverted* technical/entity queries (e.g. "Intel X550" → relevant 0.107, lowest). The 1.5B ranks
  correctly and lands relevant docs at a reliable **~1.0**, length-robust. Caveat: irrelevant docs
  **scatter 0.0–0.9** (not the "≈0" the rig claimed) and gibberish queries score high — so "is
  anything relevant" can't be score-gated (hence the retrieval-based empty state above).
- **Cutoff = relative band** (cycle 33), anchored to the reliable ~1.0 top — cleanly trims the
  noise tail, robust to the length-dependent scale + the false-positive scatter. The old fixed
  absolute `rerankCutoff` is gone.
- **Earlier retractions stand:** the cycle-32 "miscalibrated / cat-photo > runbook / gibberish→0.999
  / model-required" notes were **test artifacts** (varied input text/length; `model`-less curls).
- **To enable in prod:** assign the mxbai model to the `rerank` usage in `/settings/model-config` (provider
  baseURL `http://192.168.2.25:8883`), then validate + tune `rerankRelBand` / `rerankTopK` on the
  real corpus. With rerank off, search uses RRF + cosine-floor + exact-pin (not free).

## Follow-ups
- Validate + tune the reranker on the real corpus once enabled (`rerankRelBand` / `rerankTopK`).
- Rerank the MCP `search_docs` / `search_passages` (agent-facing) too — currently only the cosine
  floor reaches them; the cross-type rerank is palette-only.
- Contextual BM25 over chunk text (Anthropic ~49%); a `/settings/*` relevance-tuning subpage.
