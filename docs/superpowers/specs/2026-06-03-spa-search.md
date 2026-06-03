---
title: Global UX & Architecture — SPA + Command Palette
cycle: 8
status: spec
date: 2026-06-03
feedback: ../../scope-feedback.md
---

# Cycle 8 — Global UX & Architecture

## Purpose
Two global changes from feedback: (1) make the authed app a SPA (fixes the pre-login `/documents` flash + the recurring hydration warnings), keeping SSR only for public pages; (2) add a command palette with semantic search across everything.

## 1. SPA + SSR public pages (locked decision)
- `nuxt.config.ts`: `ssr: false` (SPA default for the whole app).
- Re-enable SSR/prerender ONLY for public routes via `routeRules`: `'/share/**': { ssr: true }`. (`/i/**` and `/api/**` are server routes, unaffected.) Confirm via `/nuxt-docs` that Nuxt 4 hybrid rendering supports per-route `ssr: true` under a global `ssr: false` — if not, use the inverse that achieves the same: global SSR with the authed pages forced client-only, OR prerender the share page. The acceptance is: **`/documents` (and all authed pages) render as SPA (no server-rendered pre-login flash); `/share/[slug]` is still server-rendered (curl returns the doc HTML without JS, with OG-able markup).**
- The client auth guard (`auth.global.ts`) becomes the normal path; remove the `import.meta.server` short-circuits and any `<ClientOnly>` hacks that were only there to dodge SSR hydration mismatches (the login page, the `/clipboard` thread resolve, etc.) — SPA removes the mismatch class entirely.
- Confirm public share page still works logged-out and authed pages redirect to `/login` cleanly with no flash.

## 2. Command palette (semantic search across everything)
- A `UDashboardSearchButton` placed **above the Capture nav item** in `app/layouts/default.vue`, opening `UDashboardSearch` (Nuxt UI v4 command palette). Keyboard shortcut (⌘K) if the component supports it.
- Unified search endpoint `server/api/search.get.ts` → `{ q }` returns grouped results across surfaces:
  - **documents** — `searchDocs(q)` (hybrid trigram+vector) → {id, path, title, type:'document'}
  - **memories** — `searchMemories(q)` (hybrid + relevance) → {id, content snippet, scope, relevance}
  - **images** — by `ocr_text` ilike + tags overlap (and optionally embedding later) → {id, serveUrl, tags}
  - **tasks** — by title/description ilike → {id, title, status}
  - **projects** — by name/slug ilike → {slug, name}
  Each result carries a `to` (route) for navigation: document → `/documents?doc=<id>`, memory → `/memories?q=...` (or highlight), image → `/gallery?img=<id>`, task → `/tasks`, project → `/projects`. Group + cap (e.g. 5 per group). Aggregate in parallel; degrade gracefully if a lane errors.
- `UDashboardSearch` groups: Documents / Memories / Images / Tasks / Projects; selecting navigates via `navigateTo(result.to)`. Debounced query → `/api/search`.

## Testing & validation
- SPA: `curl /documents` (logged out) returns the SPA shell (NO server-rendered `/documents` content/flash); `curl /share/<public-slug>` returns server-rendered doc HTML. Browser (playwright-cli): hard-load `/` logged out → lands on `/login` with no `/documents` flash; no hydration-mismatch console errors on login/clipboard.
- Palette: ⌘K / button opens search; typing a known term shows grouped results from multiple surfaces; selecting a document navigates and opens it.
- Gates: typecheck/build/test.

## Non-goals
Per-surface search UIs (gallery/tasks get their own filters in cycle 10); the palette is global quick-jump. No fuzzy/typo correction beyond what trigram+vector give.

## Definition of done
The authed app is a SPA (no pre-login flash, no hydration warnings); public share pages remain server-rendered; a ⌘K command palette searches documents/memories/images/tasks/projects semantically and jumps to results. Wiki: add `search.md`, note SPA in a rendering note; handover; roadmap cycle-8 → shipped.
