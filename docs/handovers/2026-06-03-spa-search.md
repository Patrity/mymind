---
title: Global UX & Architecture — SPA + Command Palette
cycle: 8
status: shipped
date: 2026-06-03
feedback: ../../scope-feedback.md
shipped:
  - "SPA for the authed app: routeRules catch-all '/**': { ssr: false } (global ssr stays true so the renderer is SSR-capable), with '/share/**': { ssr: true } keeping public share pages server-rendered. Fixes the pre-login /documents flash AND the recurring hydration-mismatch warnings."
  - "Removed SSR-only hacks: auth.global.ts import.meta.server short-circuit, clipboard.vue client-only thread resolve, the <ClientOnly> wrap around CodeEditor (the .client.vue suffix already handles browser-only)."
  - "Unified search: server/services/search.ts searchAll(q) fans out 5 fault-isolated lanes (documents hybrid, memories hybrid+relevance, images ocr/tags ilike, tasks title/desc ilike, projects name/slug ilike), capped per group, each result carries a `to` route. GET /api/search."
  - "Command palette: UDashboardSearchButton above Capture + UDashboardSearch (⌘K) wired to /api/search, grouped (Documents/Memories/Images/Tasks/Projects), navigate-on-select; documents.vue reads ?doc=<id> to open a doc (deep-link)."
deferred:
  - "Image search lane uses exact tag-equality + ocr_text ilike (not prefix/semantic on tags); fine for quick-jump. Could add image embeddings + vector search later."
  - "better-auth form sign-in returns 403 on cross-origin/CSRF when BETTER_AUTH_URL != served origin — set BETTER_AUTH_URL to the real origin in prod; automated tests use cookie injection."
  - "Palette i18n: set explicit title/description props (Nuxt UI's built-in dashboardSearch.* keys weren't resolving without an i18n config)."
next_seam: "Cycle 9 (Documents power-editor): custom MDC components + a markdown toolbar (.md only), inline image paste->upload(public)->embed, drag-drop move (VueUse), context menu (rename/move/share/delete) ported from codethis, copy-public-link, last-open cookie. The ?doc deep-link + SPA from cycle 8 make the editor work cleaner."
validation: "typecheck + build + 107 tests; preview curls: /documents & /tasks = SPA shell (0 app content), /share/<slug> = SSR'd content; playwright: no pre-login flash, no hydration errors, palette grouped results for 'pgvector' (docs+memories), selecting a doc opens it via ?doc=, public share renders logged-out."
---

# Cycle 8 — Global UX & Architecture (handover)

Round-2 batch 2. Two global changes from feedback.

## 1. SPA for the app, SSR for public pages
**Mechanism (learned empirically):** Nuxt 4 only honors per-route `ssr: false` (SSR→SPA), NOT global `ssr:false` + per-route `ssr:true` (global `ssr:false` compiles an SPA-only renderer). So: leave global `ssr` at default `true`, and `routeRules: { '/**': { ssr:false }, '/share/**': { ssr:true } }`. Everything is SPA by default (new pages included — no per-route maintenance), public share stays SSR. This eliminated the pre-login flash and the whole hydration-mismatch class.

## 2. Command palette (semantic, cross-surface)
⌘K (or the button above Capture) opens `UDashboardSearch`. Backed by `GET /api/search` → `searchAll(q)` which queries documents + memories (both hybrid vector+trigram) + images + tasks + projects in parallel, fault-isolated, capped per group. Each result has a `to`; selecting navigates (documents open via `?doc=`).

## Where things live
`nuxt.config.ts` (routeRules), `app/middleware/auth.global.ts`, `server/services/search.ts`, `server/api/search.get.ts`, `shared/types/search.ts`, `app/components/AppSearch.client.vue`, `app/composables/useGlobalSearch.ts`, `app/layouts/default.vue`, `app/pages/documents.vue` (?doc read).
