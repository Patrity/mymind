# Global UX & Architecture (SPA + Command Palette) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** SPA for the authed app (SSR only for public pages) + a ⌘K command palette with semantic search across documents/memories/images/tasks/projects.

**Tech Stack:** Nuxt 4 (hybrid rendering / routeRules), Nuxt UI v4 (`UDashboardSearch`/`UDashboardSearchButton`), existing services (searchDocs/searchMemories/images/tasks), playwright-cli.

---

### Task 1: SPA conversion (SSR only for public pages)
**Files:** `nuxt.config.ts`; `app/middleware/auth.global.ts`; remove SSR-only hacks in `app/pages/login.vue`, `app/pages/clipboard.vue` (client-only thread resolve), any `<ClientOnly>` added to dodge hydration.
- [ ] Use `/nuxt-docs` to confirm the Nuxt 4 mechanism. Set `ssr: false` and add `routeRules: { '/share/**': { ssr: true } }` (keep existing `/` redirect rule; `/api/**` unaffected). If global-false + per-route-true isn't supported, achieve the acceptance another way (e.g. prerender `/share/[slug]`) — document the chosen mechanism.
- [ ] Simplify `auth.global.ts`: with SPA there's no server pass; the client guard runs on load. Remove `import.meta.server` short-circuits; keep `/login` + `/share/**` exemptions + redirect-loop guard.
- [ ] Remove hydration-dodge hacks now unnecessary under SPA (note each removal).
- [ ] Validate: `curl -s localhost:3000/documents` (logged out) → SPA shell, NOT server-rendered documents content (no flash); `curl -s localhost:3000/share/<public-slug>` → server-rendered doc HTML (heading present without running JS). `pnpm build` (confirm the build emits a SPA + the prerendered/SSR share route). Commit.

### Task 2: unified search endpoint
**Files:** `server/services/search.ts` (aggregator), `server/api/search.get.ts`, `shared/types/search.ts`.
- [ ] `searchAll(q, { perGroup=5 })`: run in parallel (Promise.all, each lane try/caught → []):
  - documents: `searchDocs(q)` → `{ type:'document', id, title, path, to:'/documents?doc='+id }`
  - memories: `searchMemories(q,{limit:perGroup})` → `{ type:'memory', id, snippet, scope, relevance, to:'/memories?focus='+id }`
  - images: `select … from images where ocr_text ilike %q% OR q = ANY(tags) OR q = ANY(recommended_tags) … live limit perGroup` → `{ type:'image', id, url, tags, to:'/gallery?img='+id }`
  - tasks: `listTasks` filtered by title/description ilike (or a small query) → `{ type:'task', id, title, status, to:'/tasks' }`
  - projects: name/slug ilike → `{ type:'project', slug, name, to:'/projects' }`
  - cap each group to perGroup; return `{ documents:[], memories:[], images:[], tasks:[], projects:[] }`.
- [ ] `GET /api/search?q=` → empty/whitespace q returns empty groups; else `searchAll`. Auth-gated.
- [ ] Smoke (dev+cookie): `curl "/api/search?q=pgvector"` returns grouped results spanning ≥2 surfaces. Commit.

### Task 3: command palette UI
**Files:** `app/components/AppSearch.client.vue` (or inline), `app/layouts/default.vue`, `app/composables/useGlobalSearch.ts`.
- [ ] `UDashboardSearchButton` above the Capture nav item in the sidebar; opens `UDashboardSearch`. Wire ⌘K if supported (Nuxt UI provides it; check `/nuxt-ui-docs`).
- [ ] Debounced query → `/api/search`; map groups into `UDashboardSearch` groups (Documents/Memories/Images/Tasks/Projects) with icons; each item's select → `navigateTo(item.to)` (and close). Memory/image items can show snippet/thumbnail.
- [ ] Verify `/documents?doc=<id>` actually opens that doc (the cycle-9 last-open/deep-link work will solidify this; for now ensure `documents.vue` reads `?doc=` query → selects it — small addition if not present).
- [ ] typecheck + build + commit.

### Task 4: validation + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: logged-out hard-load `/` → `/login`, NO `/documents` flash, no hydration errors; open palette (⌘K/button), search a cross-surface term, select a document result → it opens. Screenshot.
- [ ] Confirm `curl /share/<slug>` still server-rendered.
- [ ] Handover; wiki (`search.md` + a rendering note on document-spine/README); roadmap cycle-8 → shipped. Final review (focus: search endpoint auth + injection-safety on the ilike lanes; SPA didn't break public share SSR or auth). Merge.

---

## Self-Review
Coverage: SPA + public SSR (T1) ✓ · unified search aggregator (T2) ✓ · ⌘K palette (T3) ✓ · validation/docs/merge (T4) ✓. The `?doc=` deep-link is also a cycle-9 item (last-open cookie) — T3 adds the minimal read so palette nav works. ilike lanes must be parameterized (no injection). Degrade gracefully per lane.
