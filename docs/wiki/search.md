---
title: Search + Command Palette
status: shipped
cycle: 8 (extended 13, 20, 31, 32)
updated: 2026-06-18
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
  3. if a `rerank` model is assigned (resolveChain('rerank')):
        ONE rerank(q, pool) → RAW cross-encoder scores; drop score < rerankCutoff,
        EXCEPT lexicalExact candidates (pinned — a known phrase always survives)
     else (unconfigured / threw / empty result): score = synthetic RRF rank, no cutoff
  4. sort by score desc → SearchHit[]
  5. return { hits, reranked }     // reranked = scores actually came from the reranker
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
- **Reranker** (`server/lib/ai/rerank.ts`): a TEI `/rerank` cross-encoder client. Returns
  **raw** `relevance_score` (the rig field is `score`; `relevance_score` accepted too) — no
  min-max, so the absolute score is usable for a cutoff. Resolved from the AI-config registry
  via `resolveChain('rerank')`; **OFF until a model is assigned to the `rerank` usage** in
  `/settings → AI`. Never blocks search (throws → fall back to RRF order; an empty result set
  also falls back).
- **Cosine floor** (per vector lane): drops nearest-neighbours past `cosineFloor` cosine
  distance before fusion — the always-on noise trim when the reranker is off/down.
- **Config** — `server/lib/search/config.ts`, `search_relevance` settings key (JSONB) over
  defaults `{ rerankCutoff: 0.2, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50 }`.
  Tunable without redeploy. Defaults are deliberately permissive (`cosineFloor 1.0` hides
  nothing) — tune down once a real corpus is observed.
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

## Operational note — reranker quality (cycle 32; corrected 2026-06-19 after rig verification)
The wired-but-off reranker is **usable**, with one structural caveat. Verified against the
homelab rig (`192.168.2.25:8883`, currently the **0.6B** `Qwen3-Reranker-0.6B-seq-cls`):

- **The Cohere shim is fully compatible.** Our client posts `{ model, query, documents }` and
  reads `relevance_score` **or** `score`; `/rerank` (bare), `/v1/rerank`, `/v2/rerank` return
  **identical scores** (the `/v1`–`/v2` Cohere envelope `relevance_score`/`document`/`meta` is
  handled by the fallback). Point the `rerank` provider `baseURL` at the right prefix (bare
  host → `/rerank`; `…/v2` → `/v2/rerank`). The **`model` field is IGNORED** by the shim (the
  loaded model is fixed by the shim's own config) — proven byte-identical with / without / a
  bogus model. It's cosmetic for us.
- **The real limitation is a length-dependent score scale**, not the shim, the model field, or
  ordering capability. The *same* content scored ~0.29 at 46 chars vs ~0.50 padded to ~600
  chars (irrelevant filler *raised* the score), so the **fixed `rerankCutoff` shipped this
  cycle is fragile**. In the in-app regime (≤512-char best-chunk passages) the 0.6B orders
  clean and equal-length heterogeneous cases correctly (on-topic 0.815 > off-topic 0.805) — but
  with razor-thin separation, so it's *marginal* on heterogeneous content.
- **Correction to the original cycle-32 notes:** the earlier "miscalibrated / cat-photo > deploy-
  runbook / gibberish→0.999" claims were **test artifacts** — diagnostic inputs that varied doc
  text/length (and one anomalous short string), not a model defect. Retracted.
- **Recommendation:** the structural fix is a **per-query relative cutoff / top-k** (robust to
  the scale shift) rather than the fixed absolute floor. A stronger reranker
  (`tomaarsen/Qwen3-Reranker-4B-seq-cls` — the shim's own default; 8B also exists) sharpens
  separation but is a **VRAM-placement decision** on the shared Zotac GPU (~17/24 GB used; the
  4B is ~8–9 GB), not a one-liner. Don't leave the 0.6B written off — re-evaluate enabling it
  in prod once the cutoff is relative.

## Follow-ups
- **Relative / top-k rerank cutoff** — replace the fixed absolute `rerankCutoff`; it fights the
  length-dependent score scale. The key correctness follow-up (own cycle).
- Optionally move to the **4B reranker** (the shim's default) for sharper separation — a VRAM-
  placement decision on the shared GPU.
- Rerank the MCP `search_docs` / `search_passages` (agent-facing) too — this cycle only the
  cosine floor reaches them; the cross-type rerank is palette-only.
- Contextual BM25 over chunk text (Anthropic ~49%); a `/settings` relevance-tuning UI tab.
