---
title: Knowledge Galaxy — Interactive 3D Knowledge Graph (Cycle 47)
status: spec
date: 2026-07-15
supersedes_task: e356a621 (Surface memory_relations graph — subsumed + broadened)
---

# Knowledge Galaxy — Interactive 3D Knowledge Graph

## Intent

A new `/galaxy` page that renders MyMind's second brain as a **rotating 3D galaxy** you can fly through, grab, edit, and connect. Every piece of curated knowledge becomes a glowing node **positioned by meaning** (a projection of its embedding), connected by the **real structural relationships** already stored, and fully editable in place. The primary job is **serendipitous, cross-type exploration** — because everything shares one embedding space, a memory can sit next to a document next to an image, surfacing connections you didn't file by hand.

This is a visual-first build: the beautiful, animated frontend is built and tuned against stub data first, then the backend is wired underneath.

The interaction model, aesthetic, and controls were validated in a live browser prototype during brainstorming (arcball grab, drag-and-throw inertia, spring-eased control panel, full-bleed 3D). The prototype lives at `.superpowers/brainstorm/*/content/galaxy-page-v5.html` (reference only).

## Goals

- One `/galaxy` page: a 3D force-free galaxy of ~2,000 nodes at 60fps.
- **Position = meaning**: node coordinates come from a single UMAP projection of the shared 2560-dim embedding space, so all entity types are co-embedded and cluster by topic. Positions are **stable** between visits (spatial memory).
- **Edges = structure**: the real stored relationships are the drawn lines (project membership, provenance, OCR source, typed memory relations).
- **Full CRUD from the graph**: hover to preview, click to open a detail pane, edit/delete any node, and manually **draw or remove relations** between memories — reusing existing services + a small set of new endpoints. Every mutation rides the live-reactivity bus (cycle 21) so the galaxy updates in place.
- **Grab-the-node feel**: arcball (trackball) rotation via quaternions + drag-and-throw inertia + idle auto-rotate; scroll-zoom; a spring-eased overlay control panel.

## Non-goals (v1)

- **Messages as nodes.** ~27K embedded messages would dominate and add noise. Messages stay a drill-down inside a session (future). Sessions appear as single nodes.
- **Conversations (agent chat) as nodes.** `conversations.summary_embedding` is reserved/unused; excluded until populated.
- **Tasks as semantic nodes.** Tasks are keyword-only (no embedding) and less "knowledge." Excluded from the cloud; they remain reachable via the project dashboard.
- **Online / incremental layout.** Layout is a batch job (cron + manual recompute), not recomputed per edit. New/edited nodes reuse cached coords until the next rebuild (a new node without coords is placed near its project hub as a fallback).
- **Persistent semantic edges.** Similarity is expressed by *position*; similarity edges are drawn only on demand ("Show similar"). The always-on lines are structural.
- **Mobile-first.** Desktop-first; the page should not break on a phone but is tuned for a large screen.

## What is vectorized (grounding facts)

Single embedding model — **`qwen3-embedding-4b`, 2560-dim, `halfvec(2560)`, HNSW cosine** — so all vectors live in one shared space. Confirmed tables with embeddings:

| Table | Column | Embedded text | Galaxy node? |
|---|---|---|---|
| `chunks` | `embedding` | doc/image passages (`source_type` document\|image) | via source (docs/images) |
| `images` | `embedding` | VLM summary | ✅ image node |
| `memories` | `embedding` | memory content | ✅ memory node |
| `sessions` | `summary_embedding` | title + summary | ✅ session node (once summarized) |
| `messages` | `embedding` | raw message content | ✗ (drill-down, future) |
| `documents` | `embedding` | **unused/null** — docs are embedded as `chunks` | ✅ doc node (see layout note) |
| `conversations` | `summary_embedding` | reserved/unused | ✗ |

**Node embedding rule:** a node appears in the galaxy once it has a usable vector.
- Memory → `memories.embedding`.
- Image → `images.embedding` (the ~2 un-enriched images are excluded until enriched).
- Session → `sessions.summary_embedding` (un-summarized sessions excluded until the `summarize-sessions` worker fills them).
- **Document → mean-pooled `chunks.embedding`** for that document (documents have no single vector; average their chunk vectors into a doc-level vector for layout + similarity). A doc with zero chunks is excluded.

Current local counts (prod similar order): memories 1,656 · sessions 463 (273 summarized) · images 34 (32 embedded) · documents 24 · projects 7 · `memory_relations` 62. Curated node set ≈ **~2,000**.

## Node & edge model

### Nodes
- **Memory, Document, Image, Session** (from the rule above).
- **Project hub** — one node per project (7 today), a bright anchor. Positioned at the **centroid of its member nodes'** projected coordinates (not embedded itself). Uncategorized is included but visually muted.
- **Size** by degree (structural connection count) so hubs and well-connected nodes pop.
- **Color** by **Type** (default) with a toggle to **Project**. Type palette: memory `#a78bfa`, document `#60a5fa`, image `#fbbf24`, session `#34d399`. Project palette: a per-project hue (reuse `useProjectColors()` from cycle 25 where set; fall back to a generated 14-hue palette).

### Edges (structural — the drawn lines)
Derived from existing columns/relations; no new "edge" storage except manual memory relations:
- **Membership**: memory / document / image / session → its **project hub** (`project_id`, or `documents.project_id`, or session's project). The connective spine.
- **Provenance**: memory → originating **session** (`memories.session_id`).
- **OCR source**: document → source **image** (`documents.ocr_id`).
- **Memory relations**: memory ↔ memory from `memory_relations` (`type` ∈ `supersedes` | `contradicts`), color-coded (violet / red), only `status='active'` shown by default.

### Similarity (on demand, not drawn persistently)
"Show similar" in the detail pane runs a cosine kNN over the node's stored vector within the galaxy node set and temporarily highlights + links the top-k neighbors. This keeps semantic exploration available without a persistent hairball.

## Layout (position pipeline)

- A **batch job** fetches every galaxy node's vector (memories, images summary, sessions summary, doc mean-pooled), assembles an `N × 2560` matrix, and runs **UMAP → 3D** (`umap-js`, pure JS, runs in Nitro; no Python). For speed/stability, optionally **PCA-reduce 2560 → ~50** before UMAP (note as a tunable). ~2,000 points is well within budget for a periodic job.
- Coordinates are **cached** in a new `graph_layout` table (below). The galaxy reads cached coords — it never recomputes UMAP on page load.
- **Project hub** coords = centroid of its members (computed post-UMAP).
- **Degree** per node is computed from the structural edges and cached alongside coords.
- **Recompute triggers**: a cron (e.g. nightly / `0 4 * * *`) + a manual "Recompute layout" admin action. Between rebuilds, a brand-new node (created via CRUD) with no cached coords is placed near its project hub with jitter so it's visible immediately; it snaps to its true semantic position on the next rebuild.
- Determinism: seed UMAP so layouts don't churn arbitrarily between rebuilds (positions stay recognizable).

## Backend

### New table — `graph_layout` (migration 0028)
Cache of computed positions + degree, keyed by node identity:
- `source_type text not null` — `memory` | `document` | `image` | `session` | `project`
- `source_id uuid not null`
- `x real`, `y real`, `z real`
- `degree int not null default 0`
- `updated_at timestamptz`
- PK `(source_type, source_id)`; index on `source_type`.

(Labels/preview text are **not** stored here — they're joined from the source tables at read time so they stay fresh.)

### Endpoints
- `GET /api/graph` → `{ nodes: GraphNode[], edges: GraphEdge[] }`.
  - `GraphNode`: `{ type, id, label, project, projectId, x, y, z, degree }` (+ a short preview for the tooltip). Assembled by joining `graph_layout` to the source tables (skip soft-deleted/archived).
  - `GraphEdge`: `{ from: {type,id}, to: {type,id}, kind }` where `kind` ∈ `membership` | `provenance` | `ocr` | `supersedes` | `contradicts`.
  - Auth-gated (session or bearer), SPA route.
- `GET /api/graph/neighbors?type=&id=&k=` → top-k cosine neighbors within the node set (for "Show similar"), returning node refs + scores. Uses the source vector (mean-pooled for docs).
- **Relation CRUD** (new): `POST /api/memory-relations` `{ fromId, toId, type }` and `DELETE /api/memory-relations/[id]`. Manual draw/remove; publish a live event; return an undo token consistent with existing mutation conventions.
- **Admin**: `POST /api/graph/recompute` → enqueues/runs the layout job (auth-gated).

### Node CRUD — reuse existing services
- **Memory**: create (new memory), edit content/tags/scope, delete (`forget`), approve/reject judge proposals — existing memory service + review endpoints.
- **Image**: edit summary/tags, delete — existing images service.
- **Document**: edit title/tags/frontmatter; heavier body edits **deep-link** to the doc editor; move/assign project (path invariant, cycle 26); delete.
- **Session**: edit title/summary; **reassign project** (reuse cycle-46 `reassignSession`); not deletable from the graph.
- **Project hub**: edit name/color (cycle 25); merge (cycle 27).
- All mutations already `publishChange(...)`; the galaxy subscribes and refetches (see Live).

### Background job
`server/tasks/compute-graph-layout.ts` (registered like the other cron tasks) — assembles vectors, runs PCA/UMAP, upserts `graph_layout`, computes degree. Emits an activity-log span (cycle 22) and a `graph` live event on completion.

## Frontend

New SPA page `app/pages/galaxy.vue` (SPA per the locked render-mode decision).

### Rendering — three.js (already a dependency; reuse the bloom aesthetic from `app/lib/viz/`)
- Nodes as a `THREE.Points` cloud (circular sprite, additive blending) or instanced sprites; **UnrealBloom** post-processing (already used by the voice reactor) for the glow.
- Edges as `LineSegments` (structural) with per-kind color; opacity driven by the Link slider.
- Project hubs = larger, brighter points with a label sprite.
- Raycaster for hover + click hit-testing against nodes.
- Quality tiers + FPS watchdog + context-loss rebuild (mirror the voice-viz robustness patterns).

### Controls (custom — ported from the validated prototype)
- **Arcball rotation** (quaternion trackball): the grabbed point tracks the cursor; **drag-and-throw inertia** (capture angular velocity at release, decay under friction); **idle auto-rotate** resumes ~2s after the last interaction. Pure quaternion helpers (`qMul`/`qFromTo`/`qConj`/`decayQ`/arcball sphere-map) live in a unit-tested module (`app/lib/galaxy/arcball.ts`).
- **Scroll-zoom**, fed through the same spring as the zoom slider.
- **Spring-eased control panel** (collapsible, top-left): Cluster spread, Zoom, Rotate speed, Node size, Glow, Link opacity — each springs to its target with a gentle overshoot. Defaults: spread **1.0**, zoom **0.9**, rotate **1.0**, node size **1.0**, glow **1.0**, link **1.0**. Spring util unit-tested.
- **Cluster spread** scales each node's distance from its project-hub centroid (a live, cheap transform on top of cached coords — not a re-layout).

### UI chrome
- **Top bar**: brand, **search-to-fly** (search a node → animate the camera to it + select), color-mode toggle (Type ⇄ Project, default **Type**).
- **Legend** (bottom-left): color rows; click a row to toggle that layer's visibility.
- **Tooltip** on hover (type · project · title/preview).
- **Detail pane** (right, glassy, slides in on click): full record + metadata + tags + relations list + CRUD actions (Edit / Show similar / Add relation / Delete) + Close. Opening/closing eases the galaxy's horizontal center so it stays framed in the visible area.
- **Draw-relation interaction**: from a selected memory, an "Add relation" mode lets you pick a target memory (click or search) and a type (supersedes/contradicts) → `POST /api/memory-relations`.

### Data + live
- Fetch `/api/graph` via `@tanstack/vue-query`.
- Add `graph` to the `ResourceName` union; the layout job publishes `graph` on rebuild. The page also invalidates on `memory` / `document` / `image` / `session` / `project` events so CRUD reflects immediately (new/edited nodes appear using fallback-near-hub coords until the next rebuild).

## Build order (frontend-first)

1. **Phase 1 — Galaxy shell + look (frontend-design led).** `galaxy.vue` + three.js scene + bloom + arcball/inertia controls + spring control panel + hover/click + detail pane (read-only) + filters + legend + search-to-fly, driven by a **stub `GET /api/graph`** returning generated mock nodes/edges/coords. Goal: nail aesthetics, feel, and 60fps. Port the arcball/spring math from the prototype into tested modules.
2. **Phase 2 — Real backend + layout.** `graph_layout` table (migration 0028) + `compute-graph-layout` job (UMAP via umap-js, doc mean-pooling, degree) + real `GET /api/graph` + `GET /api/graph/neighbors`. Swap stub → real data. Seed the first layout.
3. **Phase 3 — CRUD + live.** Relation CRUD endpoints + wire detail-pane actions to existing services + create/draw-relation interactions + `graph` live event + vue-query invalidation. Undo tokens on mutations.

## Reuse

- **three.js + UnrealBloom + quality/FPS/context-loss patterns** from `app/lib/viz/` (voice reactor).
- **Live reactivity** (cycle 21): `publishChange` / `/api/events` / vue-query.
- **Embedding helper** `server/lib/ai/embeddings.ts` (`embedOne`) and the existing per-type search services for neighbors.
- **Existing CRUD services**: memories, images, documents (+ path invariant, cycle 26), sessions (+ reassign, cycle 46), projects (+ color cycle 25, merge cycle 27).
- **`memory_relations`** table + `memory-judge` / `memory-resolve` writers (cycle 13) — the manual relation endpoints write the same table.

## Testing / verification

- Gates: `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm db:migrate` (0028).
- Unit tests (pure logic): arcball quaternion math + inertia decay; spring easing; graph assembly (nodes/edges from fixtures, soft-delete exclusion, doc mean-pool, degree calc); neighbors kNN ranking; UMAP wrapper determinism (seeded).
- **Browser E2E (playwright-cli, per project rule)**: load `/galaxy` (auth-gated); orbit + throw produces motion; hover shows tooltip; click opens the detail pane; edit a memory persists + live-updates the node; draw a relation persists + a line appears; delete removes the node; color toggle + legend filters work; search-to-fly selects a node. Validate 0 console errors and interaction on reka-ui controls with real clicks.

## Open questions / deferred

- Message drill-down inside a session node (expand a session → its messages). Future.
- Conversation nodes once `conversations.summary_embedding` is populated.
- Persistent semantic-edge mode (draw kNN lines) as an optional toggle if wanted later.
- Incremental/online layout (avoid full rebuild) if the node count grows large.
- PCA-before-UMAP tuning + reproducible seeding decisions (settle during Phase 2).
- Tasks as nodes (currently excluded; revisit if useful).
- Reconcile task **e356a621** (surface memory_relations) — this cycle delivers its intent; close or fold it on ship.
