---
title: Search + Command Palette
status: shipped
cycle: 8 (extended 13, 20, 31)
updated: 2026-06-18
---

# Search + Command Palette

A global ⌘K command palette that searches across every surface and jumps to results.

## Aggregator — `server/services/search.ts`
`searchAll(q, perGroup=5)` fans out lanes in parallel (`Promise.all`), each independently try/caught (a lane failure → `[]`, never tanks the whole search):
| Lane | Backing | Match |
|---|---|---|
| documents | `searchDocs(q)` | hybrid trigram + **chunk**-vector (RRF, best-chunk-per-doc) — cycle 31 |
| memories | `searchMemories(q)` | hybrid + `relevance` score |
| images | `searchImages(q)` | hybrid lexical + summary-vector + **OCR-chunk**-vector (RRF) — cycle 20, 31 |
| sessions | session search | semantic (session-summary vector, RRF) — cycle 13 |
| messages | message search | semantic (message vector, RRF) — cycle 13 |
| tasks | `listTasks` | title/description ILIKE |
| projects | `listProjects` | name/slug ILIKE |
Each result carries `type` + a `to` route (e.g. document → `/documents?doc=<id>`, session → `/sessions/<id>`). All ILIKE queries are drizzle-parameterized (no injection). `GET /api/search?q=` (auth-gated) returns the grouped `SearchResults` (`shared/types/search.ts`); blank `q` → empty groups.

> **Chunking (cycle 31):** the document + image vector lanes no longer embed whole sources — they search a per-chunk `chunks` index (best-chunk-per-doc collapse) and the chunk embeddings carry LLM-generated contextual prefixes. For chunk-level passages (RAG context for agents), use `searchPassages` / the MCP `search_passages` tool. See [`chunking.md`](chunking.md).

## Palette — `app/components/AppSearch.client.vue`
`UDashboardSearchButton` (above the Capture nav) + `UDashboardSearch` (⌘K), debounced query → `/api/search`, results mapped to grouped command items with icons; `onSelect` → `navigateTo(item.to)`. `documents.vue` reads `?doc=<id>` to open the selected document. Explicit `title`/`description` props (Nuxt UI's built-in i18n keys need them).

## Rendering note (cycle 8)
The app is a **SPA** (`routeRules '/**': { ssr:false }`, global `ssr` stays `true`); only `/share/**` is SSR (`{ ssr:true }`). This removed the pre-login `/documents` flash and the hydration-mismatch warnings. New pages are SPA by default via the catch-all.

## Follow-ups
- Image semantic search shipped (cycle 20 — `searchImages` hybrid RRF); session + message semantic lanes shipped (cycle 13). The tasks/projects lanes are still ILIKE-only (no vector) — fine at single-user scale.
- The reranker (`Qwen3-Reranker` at `:8883`) is wired but off by default — could re-rank the fused palette results.
