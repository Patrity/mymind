---
title: Knowledge Galaxy (/galaxy)
status: shipped
cycle: 47
updated: 2026-07-16
---

# Knowledge Galaxy

An interactive **3D knowledge graph** of the whole second brain at **`/galaxy`** (authed SPA). Nodes are positioned by *meaning* (a UMAP projection of the shared embedding space), connected by the *real stored relationships*, and fully editable in place. This is the living reference for how it works today.

## Node & edge model

**Nodes** (`GraphNodeType` in `shared/types/graph.ts`): `memory`, `document`, `image`, `session`, `project`. A node appears once it has a usable vector:
- memory → `memories.embedding`; image → `images.embedding` (summary); session → `sessions.summary_embedding` (once the summarize-sessions worker has run); document → **mean-pool of its `chunks.embedding`** (documents have no single vector — they're embedded per chunk); project → a **hub** positioned at the centroid of its member nodes.

**Edges** (`GraphEdgeKind`): drawn lines are STRUCTURAL —
- `membership`: memory/document/session → its project hub (by `project_id`). *Images have no `project_id`, so image nodes get no membership edge — they connect only via `ocr`.*
- `provenance`: memory → originating session (`memories.session_id`).
- `ocr`: document → source image (`documents.ocr_id`).
- `supersedes` / `contradicts`: memory ↔ memory from `memory_relations` (status `active` only), colour-coded violet / red.

Semantic similarity is **not** a persistent edge — position encodes it, and **selecting a node auto-highlights its cosine-kNN neighbours** (the former manual "Show similar" button was removed; the highlight now fires on selection via `GET /api/graph/neighbors`).

## Position (layout)

All entities share one model — **`qwen3-embedding-4b`, 2560-dim `halfvec`, HNSW cosine** — so a SINGLE UMAP projection places every type coherently. Computed by the nightly job and cached; the page never runs UMAP on load.

- Job: `server/tasks/compute-graph-layout.ts` (`runComputeGraphLayout()`), cron **`0 4 * * *`**. Loads live vectors (memories not-archived, images not-deleted, sessions summarized, docs mean-pooled/not-deleted), runs `computeLayout(items, SEED=42)` (`server/lib/galaxy/layout.ts`, `umap-js`, seeded → **stable** coords), computes project-hub centroids + per-node degree (via `buildEdgeSourceRows` + `assembleEdges`), and **upserts** `graph_layout`.
- Manual rebuild: `POST /api/graph/recompute`. ⚠️ **Synchronous** — UMAP over ~2k vectors blocks the event loop for tens of seconds (background/manual only, never UI-triggered).

## Schema — `graph_layout` (migration 0028)

`server/db/schema/graph-layout.ts` — coordinate + degree cache:

| column | type | notes |
|---|---|---|
| `source_type` | text | memory\|document\|image\|session\|project — part of PK |
| `source_id` | uuid | part of PK |
| `x` `y` `z` | real | UMAP 3D coords (hub = member centroid) |
| `degree` | int | canonical edge count (feeds node size) |
| `updated_at` | timestamptz | |

PK `(source_type, source_id)`; index on `source_type`. **Empty until the job runs** — after a fresh deploy, trigger a recompute or wait for the cron.

## Endpoints (auth-gated by global middleware)

- `GET /api/graph` → `{ nodes, edges }` — joins `graph_layout` to source tables (skips soft-deleted); edges from `buildEdgeSourceRows` → `assembleEdges`, filtered to the rendered node set (no dangling edges). `server/services/graph.ts` `getGraph()`.
- `GET /api/graph/neighbors?type=&id=&k=` → top-k cosine neighbours (uuid-validated). Uses the node's OWN stored vector (mean-pools docs); excludes self. `getNeighbors()`.
- `POST /api/graph/recompute` → runs the layout job.
- `GET`/`PATCH /api/memories/[id]` — PATCH is zod-field-limited (content/scope/project/tags) → `updateMemory`.
- `POST`/`DELETE /api/memory-relations` — manual supersede/contradict edges; uuid-validated; `POST` returns `{ created }` (`created:false` on a no-op conflict) + an undo token.

## Frontend

- **Layout:** the page uses the **default dashboard layout** (sidebar visible). The canvas + all overlays live inside a `stage` container (`position:relative`) that fills the main content panel (`UDashboardPanel`, body padding killed); the `<canvas>` is `absolute inset-0` within it (not `fixed` to the viewport) and every overlay is `absolute`, so the scene sizes to the panel via `canvas.getBoundingClientRect()` and resizes cleanly. *(Earlier it was `layout:false` / full-bleed.)*
- Page `app/pages/galaxy.vue` + composable `app/composables/useGalaxy.ts` (vue-query `['graph']`). Overlays: `GalaxyControls` (sliders), `GalaxyLegend` (**isolate filter**), `GalaxyDetail` (right pane, per-type CRUD + draw-relation).
- **Legend = isolate/filter** (not hide): clicking rows builds an **active set** (`useGalaxy.activeKeys`, empty = show all); non-empty shows ONLY nodes whose legend key (`node.type` in Type mode, `node.project ?? '__none__'` in Project mode) ∈ the set. Multiple clicks union; inactive rows dim + a "Filtering" badge shows. Wired page→scene via `scene.setActiveKeys(active)`.
- **Selection** (click a node, or fly-to): opens the detail pane, **boosts the effective glow to ~2× the slider value** (a springed bloom multiplier capped at the glow max — never mutates the slider), and **auto-highlights the node's kNN neighbours** (skipped for projects, which carry no vector). Deselect/close reverts the glow.
- **Selection ring** is sized **proportional to the node's on-screen radius** (`≈1.8×`, tracks the `size` slider + perspective/depth), not fixed screen pixels — so it hugs just outside the node at any zoom instead of ballooning.
- Scene `app/lib/galaxy/scene.ts` — three.js `Points` (additive, colour by type/project, size ∝ √degree) + `UnrealBloomPass`; `LineSegments` edges by kind; **quaternion arcball** camera (`app/lib/galaxy/arcball.ts`) so the grabbed node tracks the cursor; **drag-throw inertia**; 2 s idle auto-rotate; scroll-zoom; `flyTo`/search; `highlight(ids)` for the neighbour flash. The cloud is **centred at the world origin** in `setData` (its centroid is subtracted from every node anchor) so the arcball pivots around the visual middle, not a corner.
- **Controls + defaults** (spring-eased, `app/lib/galaxy/spring.ts`; useGalaxy + scene spring-init kept in lockstep): Cluster spread **1.14**, Zoom 0.9, Rotate 1.0, Node size **0.8**, Glow **0.3**, Link opacity **0.4**. Glow slider min is **0.0** (renders with no bloom). Colour default **Type** (toggle Project). *(Glow/size/spread were retuned for ~1,900 real nodes — the 230-node prototype's 1.0 defaults bloomed to a white cloud.)*

## Live reactivity

`graph` is a `ResourceName` (`shared/types/live.ts`). The layout job + relation writes `publishChange('graph')`; the client dispatch map (`app/utils/live-dispatch.ts`) invalidates `['graph']` on `graph|memory|document|image|session|project` events, **debounced 700 ms** so an enrichment-cron burst collapses to one refetch. Mutations from the detail pane refresh the galaxy through this path (no manual refetch).

## Not included (v1)

Messages as nodes (too noisy — a session drill-down is future), agent conversations (reserved `summary_embedding`, unused), tasks (keyword-only, no embedding).
