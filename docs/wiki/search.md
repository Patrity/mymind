---
title: Search + Command Palette
status: shipped
cycle: 8
updated: 2026-06-03
---

# Search + Command Palette

A global ⌘K command palette that searches across every surface and jumps to results.

## Aggregator — `server/services/search.ts`
`searchAll(q, perGroup=5)` fans out 5 lanes in parallel (`Promise.all`), each independently try/caught (a lane failure → `[]`, never tanks the whole search):
| Lane | Backing | Match |
|---|---|---|
| documents | `searchDocs(q)` | hybrid trigram + vector (RRF) |
| memories | `searchMemories(q)` | hybrid + `relevance` score |
| images | `images` | `ocr_text` ILIKE + tag/recommended-tag match |
| tasks | `listTasks` | title/description ILIKE |
| projects | `listProjects` | name/slug ILIKE |
Each result carries `type` + a `to` route (e.g. document → `/documents?doc=<id>`). All ILIKE queries are drizzle-parameterized (no injection). `GET /api/search?q=` (auth-gated) returns the grouped `SearchResults` (`shared/types/search.ts`); blank `q` → empty groups.

## Palette — `app/components/AppSearch.client.vue`
`UDashboardSearchButton` (above the Capture nav) + `UDashboardSearch` (⌘K), debounced query → `/api/search`, results mapped to grouped command items with icons; `onSelect` → `navigateTo(item.to)`. `documents.vue` reads `?doc=<id>` to open the selected document. Explicit `title`/`description` props (Nuxt UI's built-in i18n keys need them).

## Rendering note (cycle 8)
The app is a **SPA** (`routeRules '/**': { ssr:false }`, global `ssr` stays `true`); only `/share/**` is SSR (`{ ssr:true }`). This removed the pre-login `/documents` flash and the hydration-mismatch warnings. New pages are SPA by default via the catch-all.

## Follow-ups
Image lane is ILIKE/exact-tag (not vector); add image embeddings for semantic image search later.
