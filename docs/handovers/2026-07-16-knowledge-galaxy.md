---
title: Knowledge Galaxy — interactive 3D knowledge graph (/galaxy)
cycle: 47
date: 2026-07-16
status: MERGED to master (local fast-forward) + PUSHED → CD deploy triggered. Gates green (typecheck 0 / test 796 / build); Phase 1/2/3 playwright-cli E2E live-passed; final whole-branch review (opus) = Ready to merge; 2 fix waves applied + re-reviewed. ⚠️ POST-DEPLOY: `graph_layout` is EMPTY on prod until the nightly cron runs or someone triggers a recompute — see Deploy steps.
branch: feat/knowledge-galaxy (built subagent-driven, 15 tasks across 3 phases + 2 fix waves + a default retune; per-task two-verdict reviews + final opus whole-branch review)
docs:
  - ../wiki/galaxy.md (living reference — schema, endpoints, layout job, node/edge model, controls)
  - ../superpowers/specs/2026-07-15-knowledge-galaxy-design.md (spec)
  - ../superpowers/plans/2026-07-15-knowledge-galaxy.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-47 row)
related:
  - ../handovers/2026-06-16-bridget-parity.md (memory_relations graph + LLM judge — surfaced here)
  - ../handovers/2026-06-12-live-reactivity.md (the live bus this rides)
  - ../handovers/2026-06-18-document-chunking.md (chunk embeddings, mean-pooled for doc node vectors)
subsumes_task: e356a621 (Surface memory_relations graph in UI/MCP — delivered + broadened)
problem: >
  Everything in MyMind (documents, images, memories, sessions) is embedded with ONE model
  (qwen3-embedding-4b, 2560-dim halfvec) — i.e. it all lives in one shared vector space — plus
  there's an explicit memory_relations graph and rich project/provenance FKs. None of that was
  visible or navigable. This cycle turns the second brain into an interactive, editable 3D galaxy:
  nodes positioned by MEANING (a UMAP projection of the shared space, so a memory can sit next to
  a doc next to an image), connected by the REAL stored relationships, fully CRUD-able in place.
---

# Knowledge Galaxy (cycle 47)

A new authed SPA page **`/galaxy`** rendering the second brain as a rotating 3D three.js graph. Built **frontend-first**: the interaction model + look were validated in a live browser prototype (arcball grab, drag-throw inertia, spring-eased control panel) BEFORE any backend, then the real data was wired underneath.

## What shipped

- **~1,907 nodes / 2,850 edges** from real data (dev): memories (1,599), sessions (273 summarized), images (30), documents (2 chunked), + 7 project hubs. A node appears once it has a usable vector.
- **Position = meaning.** One UMAP projection (`umap-js`, seeded, in-Nitro) of every node's 2560-dim vector → stable 3D coords cached in `graph_layout`. Documents have no single vector (they're embedded as `chunks`), so a doc's layout/neighbor vector is the **mean-pool of its chunk embeddings**. Positions are stable between visits.
- **Edges = structure** (drawn lines): item→project-hub **membership**, memory→session **provenance** (`memories.session_id`), document→source-image **ocr** (`documents.ocr_id`), and memory↔memory **supersedes/contradicts** from `memory_relations` (active only, colour-coded). Similarity stays **on-demand** ("Show similar" → cosine kNN neighbours highlight), not persistent lines.
- **Full CRUD + draw-relation** from a right detail pane: edit/archive a memory (+undo), **draw a supersedes/contradicts relation** between two memories (+undo), reassign a session's project (reuses the cycle-46 `ReassignProjectModal`), delete images/docs, "+ New memory". Heavy edits **deep-link** to the existing editors (`/documents?doc=`, `/gallery?image=`, `/projects/<slug>`, `/sessions/<id>`). Every mutation rides the live bus.
- **Live-reactive** (cycle-21 bus): `graph` added to `ResourceName`; the layout job + relation writes publish `graph`; a live event on `graph|memory|document|image|session|project` invalidates the galaxy query — **debounced 700 ms** so an enrichment-cron burst collapses to one refetch.
- **Controls** (spring-eased overlay panel): Cluster spread, Zoom, Rotate speed, Node size, Glow, Link opacity. **Defaults retuned for real ~2k-node scale** (Glow 0.35 / Node size 0.55 / Cluster spread 1.2) after the prototype's 1.0/1.0 blew out to a white cloud at 1,600 memories.

## Architecture / where things live

- Pure, unit-tested modules: `app/lib/galaxy/arcball.ts` (quaternion trackball + inertia), `app/lib/galaxy/spring.ts`, `server/lib/galaxy/layout.ts` (`meanPool` + seeded UMAP).
- Scene: `app/lib/galaxy/scene.ts` — three.js `Points` + `UnrealBloomPass` (bloom wiring mirrors `app/lib/viz/scene.ts`), `LineSegments` edges, quaternion arcball camera (grabbed point tracks cursor via fov-derived zoom), drag-throw inertia, DPR resize, full dispose + context-loss.
- Page/UI: `app/pages/galaxy.vue`, `app/composables/useGalaxy.ts`, `app/components/galaxy/{GalaxyControls,GalaxyLegend,GalaxyDetail}.vue`.
- Backend: `server/services/graph.ts` (`getGraph`, `getNeighbors`, `assembleEdges`, `buildEdgeSourceRows`), `server/tasks/compute-graph-layout.ts` (the nightly job, `runComputeGraphLayout()`), `server/services/memory-relations.ts`.
- Schema: `server/db/schema/graph-layout.ts` + **migration 0028** (`graph_layout`: `(source_type, source_id)` PK, `x/y/z`, `degree`, `updated_at`; table-only).

## Endpoints (all auth-gated by global middleware)

- `GET /api/graph` → `{ nodes, edges }` (joins `graph_layout` to source tables; edges via `assembleEdges`; filtered to the rendered node set).
- `GET /api/graph/neighbors?type=&id=&k=` → top-k cosine neighbours (uuid-validated).
- `POST /api/graph/recompute` → runs the layout job (synchronous — see below).
- `GET`/`PATCH /api/memories/[id]` (PATCH is zod-field-limited to content/scope/project/tags → `updateMemory`).
- `POST`/`DELETE /api/memory-relations` (uuid-validated; supersedes|contradicts only; returns `{ created }` + undo token).
- Cron: `compute-graph-layout` at `0 4 * * *` (nightly).

## Deploy steps (⚠️ read before/after the CD deploy)

1. Push to `master` triggers the CD pipeline (cycle 34) → deploys to LXC 114, runs `db:migrate` (applies **0028**, table-only/safe).
2. **`graph_layout` starts EMPTY on prod**, so `/galaxy` will show an empty scene until the layout is computed. To populate it immediately, trigger a recompute (authed): `POST /api/graph/recompute` — or wait for the 04:00 cron.
3. ⚠️ **The recompute is synchronous** — UMAP over ~2k×2560-dim vectors blocks the Nitro event loop for tens of seconds (no PCA pre-reduction, no worker offload). It's background-only (cron + manual), never UI-triggered, so acceptable — but expect the box to be briefly busy when it runs. Runs in-process (umap-js), needs no external service; reads existing embeddings only.

## Verification

- Gates: typecheck 0 / **test 796** / build. Migration 0028 applies cleanly.
- Phase-1 E2E: fullscreen canvas, drag+inertia, hover/click, recolor, legend toggle, 0 console errors.
- Phase-2 gate: `/api/graph` serves 1,907 real nodes / 2,850 edges, idempotent recompute.
- Phase-3 E2E: memory edit persists+live-updates, archive+undo, draw-relation (row + violet edge + undo), session reassign re-points, show-similar highlights 8, 0 console errors.
- Reviews: per-task two-verdict reviews (all approved) + final opus whole-branch review (Ready to merge, 0 Critical) + 2 fix waves (GPU-buffer leak in highlight; invalidation debounce + no-op relation guard + uuid validation), each re-reviewed.

## Deferred / fast-follows (none merge-blocking)

- **Full refetch on invalidation.** The `['graph']` invalidation is now debounced, but still refetches the whole ~1,900-node payload + rebuilds all GPU buffers. Fine at this scale; an incremental/patch update is the next optimization if the corpus grows.
- **Synchronous recompute** (above) — move off-thread (worker/queue) if a "Recompute" button is ever surfaced in the UI.
- **Images have no `project_id`** → image nodes get no membership edge (only connect via `ocr`); standalone images float, positioned by semantics only. Matches the schema; add an image→project column if membership is wanted.
- **Stored `degree`** counts the full canonical edge model (incl. edges to non-positioned nodes), so a hub's size can slightly overstate its drawn edges. Cosmetic (feeds node size only).
- Minor cleanups (from reviews): no committed regression test for the n=1/empty `computeLayout` paths; `loadNodeVector` document case doesn't filter soft-deleted docs; `deleteMemoryRelation` SELECT-then-DELETE (non-atomic, single-user); per-relation DELETE of OLDER edges deferred (the `GraphEdge` DTO carries no relation row id — you can only undo-delete the just-created edge); `GalaxyDetail.vue` is dense (+393 lines — extract edit/relate panels if more are added); palette constants duplicated between `scene.ts` and `GalaxyLegend.vue`; hover uses manual screen-space picking (not `THREE.Raycaster`).
- **Non-goals (v1):** messages (~27k, too noisy — a session drill-down is future), agent conversations (reserved `summary_embedding`, unused), tasks (keyword-only, no embedding).
