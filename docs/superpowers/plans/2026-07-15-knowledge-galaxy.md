# Knowledge Galaxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/galaxy` page that renders MyMind's second brain as an interactive, editable 3D knowledge graph — nodes positioned by meaning (UMAP of the shared embedding space), connected by real structural relationships, fully CRUD-able in place.

**Architecture:** Frontend-first in three phases. **P1** builds the three.js galaxy + arcball/inertia controls + spring control panel + detail pane against a *stub* `GET /api/graph`. **P2** replaces the stub with a real backend: a `graph_layout` cache table, a UMAP layout job, and the real graph/neighbors endpoints. **P3** wires full CRUD (edit/delete/create + draw memory relations) to existing services and the cycle-21 live bus.

**Tech Stack:** Nuxt 4 (SPA), Vue 3, Nuxt UI v4 / reka-ui, three.js (+ UnrealBloom, already a dep), `umap-js` (new dep), Drizzle + Postgres + pgvector (`halfvec(2560)`), @tanstack/vue-query, better-auth, Vitest, playwright-cli.

## Global Constraints

- Package manager: **pnpm** only (never npm/yarn). `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:migrate`.
- Embeddings: `qwen3-embedding-4b`, **2560-dim**, stored `halfvec(2560)`, HNSW cosine. Never change dim.
- Render mode: **SPA** (`ssr:false`) for authed pages; `/galaxy` is authed (session or bearer).
- Live data: every Nitro writer calls `publishChange({resource,action,id})`; reads use `@tanstack/vue-query`; the closed `ResourceName` union gates resource names (see `.claude/rules/live-data.md` + `add-live-resource` skill).
- Reka-ui gotcha: never give `USelectMenu`/`ComboboxItem` an empty-string value — use a non-empty sentinel.
- Web validation: use **`playwright-cli`** (NOT the MCP browser) per project rule; see the `browser-testing` skill.
- Migrations are sequential; next number is **0028** (latest is `0027`).
- Vitest excludes `.claude/**`; test files live beside sources or under `test/`.
- Interaction/visual reference (validated prototype, on disk, gitignored): `.superpowers/brainstorm/38822-1784166080/content/galaxy-page-v5.html`. Port its arcball + spring + render math; do not reinvent.
- Spec: `docs/superpowers/specs/2026-07-15-knowledge-galaxy-design.md`.

---

## File Structure

**Shared**
- Create `shared/types/graph.ts` — `GraphNode`, `GraphEdge`, `GraphData`, `GraphNeighbor` DTOs (used by client + server).

**Frontend (P1)**
- Create `app/lib/galaxy/arcball.ts` — pure quaternion trackball + inertia math (unit-tested).
- Create `app/lib/galaxy/arcball.test.ts`
- Create `app/lib/galaxy/spring.ts` — pure spring easing (unit-tested).
- Create `app/lib/galaxy/spring.test.ts`
- Create `app/lib/galaxy/scene.ts` — three.js scene: points cloud + bloom + edge lines + raycast; ported from the prototype.
- Create `app/composables/useGalaxy.ts` — reactive glue: fetch graph (vue-query), drive scene, control state, selection.
- Create `app/pages/galaxy.vue` — the page shell (canvas + overlays).
- Create `app/components/galaxy/GalaxyControls.vue` — spring slider panel.
- Create `app/components/galaxy/GalaxyLegend.vue` — color legend + layer toggles.
- Create `app/components/galaxy/GalaxyDetail.vue` — right detail pane (read-only in P1; CRUD in P3).
- Create `server/api/graph/index.get.ts` — **stub** in P1, real in P2.

**Backend (P2)**
- Create `server/db/schema/graph-layout.ts` — `graph_layout` table.
- Modify `server/db/schema/index.ts` — export the new table.
- Create `server/db/migrations/0028_*.sql` — via `pnpm db:generate` (+ hand-checked).
- Create `server/lib/galaxy/layout.ts` — `meanPool`, `computeLayout` (umap-js wrapper, seeded). Unit-tested.
- Create `server/lib/galaxy/layout.test.ts`
- Create `server/services/graph.ts` — `getGraph()`, `getNeighbors()`. Unit-tested (assembly).
- Create `server/services/graph.test.ts`
- Create `server/tasks/compute-graph-layout.ts` — cron/manual job.
- Create `server/api/graph/neighbors.get.ts`
- Create `server/api/graph/recompute.post.ts`
- Modify `server/api/graph/index.get.ts` — swap stub → `getGraph()`.
- Modify `nuxt.config.ts` (or the scheduler config) — register the cron task.

**CRUD + live (P3)**
- Create `server/services/memory-relations.ts` — `createMemoryRelation`, `deleteMemoryRelation` (+ restore for undo).
- Create `server/api/memory-relations/index.post.ts`
- Create `server/api/memory-relations/[id].delete.ts`
- Modify the `ResourceName` union (find via `add-live-resource` skill) — add `'graph'`.
- Modify `server/tasks/compute-graph-layout.ts` — `publishChange({resource:'graph',...})` on completion.
- Modify `app/components/galaxy/GalaxyDetail.vue` — wire edit/delete/create/reassign/draw-relation to existing endpoints.
- Modify `app/composables/useGalaxy.ts` — invalidate on `graph`/`memory`/`document`/`image`/`session`/`project` events.

---

# PHASE 1 — Galaxy shell + look (against a stub)

## Task 1.1: Shared graph types

**Files:**
- Create: `shared/types/graph.ts`

**Interfaces:**
- Produces: the DTOs every other task imports.

- [ ] **Step 1: Write the types**

```ts
// shared/types/graph.ts
export type GraphNodeType = 'memory' | 'document' | 'image' | 'session' | 'project'

export interface GraphNode {
  type: GraphNodeType
  id: string
  label: string          // short display title
  preview?: string       // longer hover/detail snippet
  project: string | null // project slug
  projectId: string | null
  x: number; y: number; z: number
  degree: number
}

export type GraphEdgeKind = 'membership' | 'provenance' | 'ocr' | 'supersedes' | 'contradicts'
export interface GraphEdgeRef { type: GraphNodeType; id: string }
export interface GraphEdge { from: GraphEdgeRef; to: GraphEdgeRef; kind: GraphEdgeKind }

export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }
export interface GraphNeighbor { type: GraphNodeType; id: string; label: string; score: number }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add shared/types/graph.ts
git commit -m "feat(galaxy): shared graph DTOs"
```

---

## Task 1.2: Arcball + inertia math (pure, tested)

Port the validated quaternion trackball from the prototype into a tested module.

**Files:**
- Create: `app/lib/galaxy/arcball.ts`
- Test: `app/lib/galaxy/arcball.test.ts`

**Interfaces:**
- Produces: `Quat`, `qMul`, `qAxis`, `qNorm`, `qConj`, `vRot`, `qFromTo`, `angleOf`, `decayQ`, `mapSphere`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/galaxy/arcball.test.ts
import { describe, it, expect } from 'vitest'
import { qAxis, qMul, vRot, qFromTo, angleOf, decayQ, mapSphere, qConj } from './arcball'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('arcball', () => {
  it('rotates a vector 90° about Y so +X → -Z', () => {
    const q = qAxis(0, 1, 0, Math.PI / 2)
    const r = vRot({ x: 1, y: 0, z: 0 }, q)
    expect(close(r.x, 0)).toBe(true)
    expect(close(r.z, -1)).toBe(true)
  })
  it('qFromTo builds the rotation carrying v0 onto v1', () => {
    const v0 = { x: 1, y: 0, z: 0 }, v1 = { x: 0, y: 1, z: 0 }
    const r = vRot(v0, qFromTo(v0, v1))
    expect(close(r.x, 0)).toBe(true); expect(close(r.y, 1)).toBe(true)
  })
  it('decayQ shrinks a rotation angle by the friction factor', () => {
    const q = qAxis(0, 1, 0, 0.4)
    expect(angleOf(decayQ(q, 0.5))).toBeCloseTo(0.2, 4)
  })
  it('decayQ is safe at ~zero angle', () => {
    const q = qAxis(0, 1, 0, 1e-9)
    expect(angleOf(decayQ(q, 0.9))).toBeLessThan(1e-4)
  })
  it('mapSphere returns a unit vector inside the ball and normalizes outside', () => {
    const inside = mapSphere(110, 100, 100, 100, 100) // 10px right of center, R=100
    expect(close(Math.hypot(inside.x, inside.y, inside.z), 1, 1e-6)).toBe(true)
    const outside = mapSphere(500, 100, 100, 100, 100)
    expect(close(outside.z, 0)).toBe(true)
    expect(close(Math.hypot(outside.x, outside.y), 1, 1e-6)).toBe(true)
  })
  it('qConj inverts a unit quaternion', () => {
    const q = qAxis(0, 1, 0, 0.7)
    const id = qMul(q, qConj(q))
    expect(close(id.w, 1, 1e-6)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/lib/galaxy/arcball.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/galaxy/arcball.ts
export interface Quat { x: number; y: number; z: number; w: number }
export interface Vec3 { x: number; y: number; z: number }

export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
export const qAxis = (x: number, y: number, z: number, ang: number): Quat => {
  const h = ang / 2, s = Math.sin(h)
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(h) }
}
export const qNorm = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}
export const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
export const vRot = (v: Vec3, q: Quat): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}
export const qFromTo = (v0: Vec3, v1: Vec3): Quat => {
  const d = v0.x * v1.x + v0.y * v1.y + v0.z * v1.z
  return qNorm({ x: v0.y * v1.z - v0.z * v1.y, y: v0.z * v1.x - v0.x * v1.z, z: v0.x * v1.y - v0.y * v1.x, w: 1 + d })
}
export const angleOf = (q: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)))
export const decayQ = (qd: Quat, f: number): Quat => {
  const ang = angleOf(qd)
  if (ang < 1e-5) return { x: 0, y: 0, z: 0, w: 1 }
  const s = Math.sin(ang / 2) || 1e-6
  return qAxis(qd.x / s, qd.y / s, qd.z / s, ang * f)
}
/** Map a screen point to a point on the virtual arcball sphere (Shoemake). */
export const mapSphere = (mx: number, my: number, cx: number, cy: number, R: number): Vec3 => {
  let x = (mx - cx) / R, y = -(my - cy) / R
  const d2 = x * x + y * y
  if (d2 <= 1) return { x, y, z: Math.sqrt(1 - d2) }
  const l = Math.sqrt(d2)
  return { x: x / l, y: y / l, z: 0 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/lib/galaxy/arcball.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/galaxy/arcball.ts app/lib/galaxy/arcball.test.ts
git commit -m "feat(galaxy): pure quaternion arcball + inertia math"
```

---

## Task 1.3: Spring easing (pure, tested)

**Files:**
- Create: `app/lib/galaxy/spring.ts`
- Test: `app/lib/galaxy/spring.test.ts`

**Interfaces:**
- Produces: `Spring`, `makeSpring(v)`, `stepSpring(s, stiffness?, damping?)`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/galaxy/spring.test.ts
import { describe, it, expect } from 'vitest'
import { makeSpring, stepSpring } from './spring'

describe('spring', () => {
  it('converges to its target', () => {
    const s = makeSpring(0); s.t = 1
    for (let i = 0; i < 400; i++) stepSpring(s)
    expect(Math.abs(s.c - 1)).toBeLessThan(1e-3)
    expect(Math.abs(s.v)).toBeLessThan(1e-3)
  })
  it('overshoots at least once (bouncy)', () => {
    const s = makeSpring(0); s.t = 1
    let max = 0
    for (let i = 0; i < 400; i++) { stepSpring(s); max = Math.max(max, s.c) }
    expect(max).toBeGreaterThan(1) // overshoot past target
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/lib/galaxy/spring.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/galaxy/spring.ts
export interface Spring { c: number; t: number; v: number }
export const makeSpring = (v: number): Spring => ({ c: v, t: v, v: 0 })
export function stepSpring(s: Spring, stiffness = 0.14, damping = 0.52): void {
  const a = (s.t - s.c) * stiffness - s.v * damping
  s.v += a
  s.c += s.v
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/lib/galaxy/spring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/galaxy/spring.ts app/lib/galaxy/spring.test.ts
git commit -m "feat(galaxy): spring-eased control value util"
```

---

## Task 1.4: Stub graph endpoint

A deterministic mock so the whole frontend can be built + tested before the backend exists.

**Files:**
- Create: `server/api/graph/index.get.ts`

**Interfaces:**
- Consumes: `GraphData` from Task 1.1.
- Produces: `GET /api/graph` → `GraphData` (stub). Replaced in Task 2.6.

- [ ] **Step 1: Write the stub**

```ts
// server/api/graph/index.get.ts
import type { GraphData, GraphNode, GraphNodeType, GraphEdge } from '~~/shared/types/graph'
// NOTE: STUB for P1. Replaced by getGraph() in P2 (Task 2.6). Keep the auth guard.
import { requireAuth } from '~~/server/utils/auth' // use the project's existing auth helper

const PROJECTS = ['homelab', 'mymind', 'claude-agent', '2d-rpg', 'bridget', 'copipasta', 'codethis']
const TYPES: GraphNodeType[] = ['memory', 'document', 'image', 'session']
const WEIGHTS = [0.62, 0.13, 0.09, 0.16] // memory-heavy

export default defineEventHandler(async (event): Promise<GraphData> => {
  await requireAuth(event) // match existing endpoints' auth pattern

  // deterministic PRNG so layout is stable across reloads
  let seed = 1337
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const pick = () => { const r = rnd(); let s = 0; for (let i = 0; i < 4; i++) { s += WEIGHTS[i]; if (r <= s) return TYPES[i] } return 'memory' as GraphNodeType }

  const nodes: GraphNode[] = []
  const hubs: GraphNode[] = PROJECTS.map((slug, p) => {
    const a = (p / PROJECTS.length) * Math.PI * 2
    return { type: 'project', id: `proj-${p}`, label: slug, project: slug, projectId: `proj-${p}`,
      x: Math.cos(a) * 0.62, y: (rnd() - 0.5) * 0.3, z: Math.sin(a) * 0.62, degree: 0 }
  })
  const edges: GraphEdge[] = []
  for (let i = 0; i < 230; i++) {
    const p = Math.floor(rnd() * PROJECTS.length), h = hubs[p]
    const rr = Math.pow(rnd(), 0.7) * 0.34, a = rnd() * Math.PI * 2, b = Math.acos(2 * rnd() - 1)
    const t = pick()
    const id = `${t}-${i}`
    nodes.push({ type: t, id, label: `${t} #${i}`, preview: `Stub ${t} node ${i}`, project: PROJECTS[p], projectId: `proj-${p}`,
      x: h.x + rr * Math.sin(b) * Math.cos(a), y: h.y + rr * Math.cos(b) * 0.7, z: h.z + rr * Math.sin(b) * Math.sin(a), degree: 1 })
    edges.push({ from: { type: t, id }, to: { type: 'project', id: h.id }, kind: 'membership' })
    hubs[p].degree++
  }
  // a few memory↔memory relations
  const mem = nodes.filter(n => n.type === 'memory')
  for (let k = 0; k < 10; k++) {
    const a = mem[Math.floor(rnd() * mem.length)], b = mem[Math.floor(rnd() * mem.length)]
    if (a !== b) edges.push({ from: { type: 'memory', id: a.id }, to: { type: 'memory', id: b.id }, kind: rnd() < 0.6 ? 'supersedes' : 'contradicts' })
  }
  return { nodes: [...nodes, ...hubs], edges }
})
```

> Implementer note: use the SAME auth guard the neighboring endpoints use (grep an existing `server/api/*.get.ts` for the pattern — likely `requireAuth`/`getAuthSession`). Replace the import above to match.

- [ ] **Step 2: Verify it serves**

Run: `pnpm dev`, then (authenticated) `curl -s localhost:3000/api/graph | head -c 200`
Expected: JSON with `nodes` + `edges`.

- [ ] **Step 3: Commit**

```bash
git add server/api/graph/index.get.ts
git commit -m "feat(galaxy): stub /api/graph for frontend-first build"
```

---

## Task 1.5: Galaxy scene module (three.js) — frontend-design led

Port the render + interaction loop from the prototype into a framework-agnostic scene controller. **This is the aesthetic task — use the `frontend-design` skill.** The prototype (`.superpowers/brainstorm/38822-1784166080/content/galaxy-page-v5.html`) is the reference for look + feel (additive-glow points, bloom, structural edges, arcball grab, drag-throw inertia, 2s idle auto-rotate). Convert its canvas-2D renderer to **three.js** (`Points` + `UnrealBloomPass`, reusing patterns from `app/lib/viz/scene.ts`), keeping the arcball/spring math from Tasks 1.2–1.3.

**Files:**
- Create: `app/lib/galaxy/scene.ts`

**Interfaces:**
- Consumes: `GraphData` (1.1); `arcball.ts` (1.2); `spring.ts` (1.3).
- Produces:
```ts
export interface GalaxyControlsState { spread: number; zoom: number; rotate: number; size: number; glow: number; link: number }
export interface GalaxyScene {
  setData(data: GraphData): void
  setColorMode(mode: 'type' | 'project'): void
  setVisibleKeys(disabled: Set<string>): void   // legend toggles
  setControls(partial: Partial<GalaxyControlsState>): void  // slider targets (spring)
  flyTo(nodeId: string): void
  onHover(cb: (node: GraphNode | null) => void): void
  onSelect(cb: (node: GraphNode) => void): void
  select(nodeId: string | null): void
  setDetailOpen(open: boolean): void            // eases horizontal center
  dispose(): void
}
export function createGalaxyScene(canvas: HTMLCanvasElement): GalaxyScene
```

- [ ] **Step 1: Implement the scene controller** (port from prototype; three.js renderer)

Key requirements (verbatim from spec + prototype):
- `THREE.Points` with a circular sprite texture + `AdditiveBlending`; per-node color by type/project; per-node size ∝ `sqrt(degree)` × `size` control. Project hubs larger/brighter.
- `EffectComposer` + `UnrealBloomPass` (copy the wiring from `app/lib/viz/scene.ts`); `glow` control drives bloom strength.
- Structural edges as `THREE.LineSegments`; color by kind (membership faint grey; supersedes violet `#a78bfa`; contradicts red `#fb7185`); opacity × `link` control.
- Camera orientation is a quaternion `q`. Pointer: `mapSphere` on mousedown (R = on-screen galaxy radius from current zoom, center eased for the detail pane), `q = qMul(qFromTo(arc0, v1), qStart)` on move; on release with velocity, set inertia `spin` and each frame `q = qMul(spin, q); spin = decayQ(spin, 0.94)` until `angleOf(spin) < 9e-4`; idle > 2000ms → `q = qMul(qAxis(0,1,0, 0.0016*rotate), q)`.
- Click vs drag: pointer moved < 5px → `select` the raycast-hit node; else rotate.
- Raycaster hover → `onHover`; `spread` scales each node's offset from its project-hub centroid (transform cached coords, not a re-layout).
- Control values are `Spring`s stepped every frame (defaults: spread 1.0, zoom 0.9, rotate 1.0, size 1.0, glow 1.0, link 1.0).
- `flyTo(nodeId)` tweens the camera/zoom to frame that node + selects it.
- DPR-aware resize; `dispose()` tears down GL + listeners; handle WebGL context loss (mirror `app/lib/viz`).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/galaxy/scene.ts
git commit -m "feat(galaxy): three.js scene controller (arcball + bloom + edges)"
```

---

## Task 1.6: Composable + page + overlay components

Wire the scene into a Nuxt page with vue-query data, the spring control panel, legend, tooltip, and a read-only detail pane.

**Files:**
- Create: `app/composables/useGalaxy.ts`
- Create: `app/pages/galaxy.vue`
- Create: `app/components/galaxy/GalaxyControls.vue`
- Create: `app/components/galaxy/GalaxyLegend.vue`
- Create: `app/components/galaxy/GalaxyDetail.vue`

**Interfaces:**
- Consumes: `createGalaxyScene` (1.5); `GET /api/graph` (1.4).
- Produces: `useGalaxy()` returning `{ graph, selected, hovered, colorMode, controls, disabledKeys, flyTo, select }`.

- [ ] **Step 1: Composable** — `useGalaxy.ts`

```ts
// app/composables/useGalaxy.ts
import { useQuery } from '@tanstack/vue-query'
import type { GraphData, GraphNode } from '~~/shared/types/graph'

export function useGalaxy() {
  const graph = useQuery({
    queryKey: ['graph'],
    queryFn: () => $fetch<GraphData>('/api/graph'),
  })
  const selected = ref<GraphNode | null>(null)
  const hovered = ref<GraphNode | null>(null)
  const colorMode = ref<'type' | 'project'>('type') // DEFAULT = type
  const disabledKeys = reactive(new Set<string>())
  const controls = reactive({ spread: 1, zoom: 0.9, rotate: 1, size: 1, glow: 1, link: 1 })
  return { graph, selected, hovered, colorMode, disabledKeys, controls }
}
```

- [ ] **Step 2: Page** — `galaxy.vue` (mounts the scene, binds overlays)

```vue
<!-- app/pages/galaxy.vue -->
<script setup lang="ts">
import { createGalaxyScene, type GalaxyScene } from '~/lib/galaxy/scene'
definePageMeta({ /* match the app's authed page meta (layout/middleware) */ })
const { graph, selected, hovered, colorMode, disabledKeys, controls } = useGalaxy()
const canvas = ref<HTMLCanvasElement>()
let scene: GalaxyScene | null = null

onMounted(() => {
  scene = createGalaxyScene(canvas.value!)
  scene.onHover(n => (hovered.value = n))
  scene.onSelect(n => (selected.value = n))
  watch(() => graph.data.value, d => d && scene!.setData(d), { immediate: true })
  watch(colorMode, m => scene!.setColorMode(m), { immediate: true })
  watch(controls, c => scene!.setControls({ ...c }), { deep: true, immediate: true })
  watch(() => selected.value?.id ?? null, id => scene!.setDetailOpen(!!id))
})
onБeforeUnmount(() => scene?.dispose())
</script>
<template>
  <div class="fixed inset-0 bg-[#05060c] text-white overflow-hidden">
    <canvas ref="canvas" class="fixed inset-0 w-screen h-screen" />
    <!-- top bar: brand, search-to-fly, color toggle (Type default) -->
    <GalaxyControls v-model="controls" />
    <GalaxyLegend :mode="colorMode" :disabled="disabledKeys" @toggle="k => disabledKeys.has(k) ? disabledKeys.delete(k) : disabledKeys.add(k)" />
    <GalaxyDetail v-if="selected" :node="selected" @close="selected = null" @fly="id => scene?.flyTo(id)" />
  </div>
</template>
```
> Fix the intentional typo (`onБeforeUnmount` → `onBeforeUnmount`) — left here so a copy-paste doesn't silently pass; the implementer must read the code.

- [ ] **Step 3: Overlay components** — build `GalaxyControls.vue` (six sliders bound to `controls`, collapsible, glassy), `GalaxyLegend.vue` (rows per color key, click to toggle), `GalaxyDetail.vue` (read-only P1: pill type, title, meta grid, tags, relations list, action buttons as no-ops placeholders + Close). Match the prototype's styling; use Nuxt UI where natural. Watch the reka-ui empty-value gotcha for any `USelectMenu`.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Browser E2E (playwright-cli)** — see `browser-testing` skill; register/login a test user.

Verify on `http://localhost:3000/galaxy`:
- canvas is full-viewport (`cvCssW`≈`innerWidth`); galaxy fills the space.
- a simulated drag rotates the scene; release keeps motion (inertia) then settles.
- hover shows a tooltip; a click (no drag) opens the detail pane.
- color toggle Type⇄Project recolors; legend row toggles hide a layer.
- 0 console errors.

- [ ] **Step 6: Commit**

```bash
git add app/composables/useGalaxy.ts app/pages/galaxy.vue app/components/galaxy/
git commit -m "feat(galaxy): page shell + controls + legend + detail (stub data)"
```

**PHASE 1 GATE:** typecheck + build green, playwright E2E of the stub galaxy passes. Frontend look/feel signed off before backend work.

---

# PHASE 2 — Real backend + UMAP layout

## Task 2.1: `graph_layout` table + migration 0028

**Files:**
- Create: `server/db/schema/graph-layout.ts`
- Modify: `server/db/schema/index.ts`
- Create: `server/db/migrations/0028_*.sql` (generated)

**Interfaces:**
- Produces: `graphLayout` table (`source_type`,`source_id` PK; `x`,`y`,`z` real; `degree` int; `updated_at`).

- [ ] **Step 1: Schema** (follow the style of `server/db/schema/memory-relations.ts`)

```ts
// server/db/schema/graph-layout.ts
import { pgTable, text, uuid, real, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'

export const graphLayout = pgTable('graph_layout', {
  sourceType: text('source_type').notNull(), // memory|document|image|session|project
  sourceId: uuid('source_id').notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  degree: integer('degree').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.sourceType, t.sourceId] }),
  byType: index('graph_layout_type_idx').on(t.sourceType),
}))
```

- [ ] **Step 2: Export it** — add `export * from './graph-layout'` to `server/db/schema/index.ts`.

- [ ] **Step 3: Generate + inspect the migration**

Run: `pnpm db:generate`
Expected: creates `server/db/migrations/0028_*.sql` with `CREATE TABLE "graph_layout"`. Open it and confirm the PK + index; no unexpected drops.

- [ ] **Step 4: Apply + typecheck**

Run: `pnpm db:migrate && pnpm typecheck`
Expected: PASS; table exists.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema/graph-layout.ts server/db/schema/index.ts server/db/migrations/0028_*.sql
git commit -m "feat(galaxy): graph_layout cache table (migration 0028)"
```

---

## Task 2.2: Layout compute — mean-pool + UMAP (pure, tested)

**Files:**
- Create: `server/lib/galaxy/layout.ts`
- Test: `server/lib/galaxy/layout.test.ts`

**Interfaces:**
- Produces:
```ts
export function meanPool(vectors: number[][]): number[]
export interface LayoutItem { type: string; id: string; vector: number[] }
export interface LayoutRow { type: string; id: string; x: number; y: number; z: number }
export function computeLayout(items: LayoutItem[], seed?: number): LayoutRow[]
```

- [ ] **Step 1: Add the dependency**

Run: `pnpm add umap-js`
Expected: `umap-js` in `package.json`.

- [ ] **Step 2: Write the failing test**

```ts
// server/lib/galaxy/layout.test.ts
import { describe, it, expect } from 'vitest'
import { meanPool, computeLayout } from './layout'

describe('layout', () => {
  it('meanPool averages component-wise', () => {
    expect(meanPool([[0, 2], [2, 4]])).toEqual([1, 3])
  })
  it('meanPool of empty is a zero-length vector (caller filters)', () => {
    expect(meanPool([])).toEqual([])
  })
  it('computeLayout returns one 3D row per item, deterministically for a fixed seed', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ type: 'memory', id: `m${i}`, vector: [Math.sin(i), Math.cos(i), i / 30] }))
    const a = computeLayout(items, 42)
    const b = computeLayout(items, 42)
    expect(a).toHaveLength(30)
    expect(a[0]).toHaveProperty('x'); expect(a[0]).toHaveProperty('z')
    expect(a).toEqual(b) // same seed → identical layout
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test server/lib/galaxy/layout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// server/lib/galaxy/layout.ts
import { UMAP } from 'umap-js'

export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0].length
  const out = new Array(dim).fill(0)
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]
  for (let i = 0; i < dim; i++) out[i] /= vectors.length
  return out
}

export interface LayoutItem { type: string; id: string; vector: number[] }
export interface LayoutRow { type: string; id: string; x: number; y: number; z: number }

export function computeLayout(items: LayoutItem[], seed = 42): LayoutRow[] {
  if (items.length === 0) return []
  // seeded PRNG so layouts are reproducible across rebuilds
  let s = seed >>> 0
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const umap = new UMAP({ nComponents: 3, nNeighbors: Math.min(15, items.length - 1), minDist: 0.1, random })
  const embedding = umap.fit(items.map(i => i.vector))
  // normalize into a unit-ish cube for stable camera framing
  let max = 1e-6
  for (const e of embedding) for (const c of e) max = Math.max(max, Math.abs(c))
  return items.map((it, i) => ({ type: it.type, id: it.id, x: embedding[i][0] / max, y: embedding[i][1] / max, z: embedding[i][2] / max }))
}
```
> `nNeighbors` guard prevents a crash on tiny sets (tests, empty DB).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test server/lib/galaxy/layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/lib/galaxy/layout.ts server/lib/galaxy/layout.test.ts package.json pnpm-lock.yaml
git commit -m "feat(galaxy): mean-pool + seeded UMAP layout (umap-js)"
```

---

## Task 2.3: Graph assembly service (tested)

Read nodes (join `graph_layout` to source tables) + edges (from FKs + `memory_relations`).

**Files:**
- Create: `server/services/graph.ts`
- Test: `server/services/graph.test.ts`

**Interfaces:**
- Consumes: `GraphData`, `GraphNeighbor` (1.1); `graphLayout` (2.1); `embedOne` (`server/lib/ai/embeddings.ts`).
- Produces:
```ts
export function assembleEdges(rows: EdgeSourceRows): GraphEdge[]  // pure, tested
export async function getGraph(): Promise<GraphData>
export async function getNeighbors(type: GraphNodeType, id: string, k: number): Promise<GraphNeighbor[]>
```

- [ ] **Step 1: Write the failing test (pure edge assembly)**

```ts
// server/services/graph.test.ts
import { describe, it, expect } from 'vitest'
import { assembleEdges } from './graph'

describe('assembleEdges', () => {
  it('builds membership, provenance, ocr, and relation edges; skips nulls', () => {
    const edges = assembleEdges({
      memberships: [{ type: 'memory', id: 'm1', projectId: 'p1' }, { type: 'image', id: 'i1', projectId: null }],
      provenance: [{ memoryId: 'm1', sessionId: 's1' }, { memoryId: 'm2', sessionId: null }],
      ocr: [{ documentId: 'd1', imageId: 'i1' }],
      relations: [{ fromId: 'm1', toId: 'm2', type: 'supersedes' }],
    })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'project', id: 'p1' }, kind: 'membership' })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'session', id: 's1' }, kind: 'provenance' })
    expect(edges).toContainEqual({ from: { type: 'document', id: 'd1' }, to: { type: 'image', id: 'i1' }, kind: 'ocr' })
    expect(edges).toContainEqual({ from: { type: 'memory', id: 'm1' }, to: { type: 'memory', id: 'm2' }, kind: 'supersedes' })
    // null projectId / sessionId produce no edge
    expect(edges.filter(e => e.kind === 'membership')).toHaveLength(1)
    expect(edges.filter(e => e.kind === 'provenance')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server/services/graph.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `assembleEdges` (pure) + the DB-backed `getGraph`/`getNeighbors`**

```ts
// server/services/graph.ts (excerpt — pure part shown in full; DB queries follow project conventions)
import type { GraphData, GraphEdge, GraphNode, GraphNodeType, GraphNeighbor } from '~~/shared/types/graph'

export interface EdgeSourceRows {
  memberships: { type: GraphNodeType; id: string; projectId: string | null }[]
  provenance: { memoryId: string; sessionId: string | null }[]
  ocr: { documentId: string; imageId: string }[]
  relations: { fromId: string; toId: string; type: 'supersedes' | 'contradicts' }[]
}

export function assembleEdges(r: EdgeSourceRows): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const m of r.memberships) if (m.projectId) edges.push({ from: { type: m.type, id: m.id }, to: { type: 'project', id: m.projectId }, kind: 'membership' })
  for (const p of r.provenance) if (p.sessionId) edges.push({ from: { type: 'memory', id: p.memoryId }, to: { type: 'session', id: p.sessionId }, kind: 'provenance' })
  for (const o of r.ocr) edges.push({ from: { type: 'document', id: o.documentId }, to: { type: 'image', id: o.imageId }, kind: 'ocr' })
  for (const rel of r.relations) edges.push({ from: { type: 'memory', id: rel.fromId }, to: { type: 'memory', id: rel.toId }, kind: rel.type })
  return edges
}

// getGraph(): SELECT graph_layout JOIN each source table (skip soft-deleted/archived) → GraphNode[];
//   fetch the four edge-source row sets → assembleEdges(). Project hub label = project slug.
// getNeighbors(type,id,k): load the node's stored vector (mean-pool chunks for a document),
//   cosine-search (<=>) within the node set's vectors, exclude self, return top-k with labels.
```
> Implementer: model the DB queries on `server/services/memory.ts` (`fetchRelationsForIds`, `searchMemories`) and `server/services/documents.ts` (`searchDocs`). Reuse `halfvec` cosine ops already in those files.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test server/services/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/graph.ts server/services/graph.test.ts
git commit -m "feat(galaxy): graph assembly + neighbors service"
```

---

## Task 2.4: Layout job + endpoints; swap the stub

**Files:**
- Create: `server/tasks/compute-graph-layout.ts`
- Create: `server/api/graph/neighbors.get.ts`
- Create: `server/api/graph/recompute.post.ts`
- Modify: `server/api/graph/index.get.ts` (stub → `getGraph()`)
- Modify: scheduler config (register the cron) — follow `server/tasks/embed-documents.ts` + how it's scheduled.

**Interfaces:**
- Consumes: `computeLayout`, `meanPool` (2.2); `getGraph`, `getNeighbors` (2.3); `graphLayout` (2.1).

- [ ] **Step 1: The job** — `compute-graph-layout.ts`

Logic (model on an existing `server/tasks/*` + `withSpan` from cycle 22):
1. Load vectors: memories (`embedding`), images (`embedding`), sessions (`summary_embedding` where non-null), documents (mean-pool their `chunks.embedding`; skip chunkless docs).
2. `computeLayout(items, SEED)`.
3. Compute project-hub coords = centroid of member rows; append as `project` rows.
4. Compute `degree` per node from the same edge sources as `getGraph`.
5. `upsert` all rows into `graph_layout` (`onConflictDoUpdate` on the PK).
6. Emit an activity-log span; (P3 adds the `graph` live event).

- [ ] **Step 2: Endpoints**

```ts
// server/api/graph/neighbors.get.ts
import { getNeighbors } from '~~/server/services/graph'
export default defineEventHandler(async (event) => {
  await requireAuth(event) // match project auth
  const q = getQuery(event)
  const type = String(q.type) as any, id = String(q.id), k = Math.min(20, Number(q.k) || 8)
  return getNeighbors(type, id, k)
})
```
```ts
// server/api/graph/recompute.post.ts
import { runComputeGraphLayout } from '~~/server/tasks/compute-graph-layout'
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  await runComputeGraphLayout()
  return { ok: true }
})
```

- [ ] **Step 3: Swap the stub** — replace `server/api/graph/index.get.ts` body with `await requireAuth(event); return getGraph()`.

- [ ] **Step 4: Seed the first layout + verify**

Run: `pnpm dev`, then `curl -s -X POST localhost:3000/api/graph/recompute` (authed), then `curl -s localhost:3000/api/graph | head -c 300`.
Expected: real nodes with non-zero coords + edges. Confirm `graph_layout` populated (`psql ... -c 'select source_type,count(*) from graph_layout group by 1'`).

- [ ] **Step 5: Gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tasks/compute-graph-layout.ts server/api/graph/ nuxt.config.ts
git commit -m "feat(galaxy): UMAP layout job + real /api/graph + /neighbors + recompute"
```

**PHASE 2 GATE:** the galaxy renders REAL data (memories/docs/images/sessions in semantic clusters, project hubs, structural edges). typecheck/test/build green; layout job populates `graph_layout`.

---

# PHASE 3 — CRUD + live

## Task 3.1: Memory-relation CRUD

**Files:**
- Create: `server/services/memory-relations.ts`
- Create: `server/api/memory-relations/index.post.ts`
- Create: `server/api/memory-relations/[id].delete.ts`
- Test: `server/services/memory-relations.test.ts`

**Interfaces:**
- Produces: `createMemoryRelation(fromId,toId,type)`, `deleteMemoryRelation(id)` — both return `{ undoToken }`; publish live events.

- [ ] **Step 1: Failing test (validation)**

```ts
// server/services/memory-relations.test.ts
import { describe, it, expect } from 'vitest'
import { validateRelationInput } from './memory-relations'

describe('validateRelationInput', () => {
  it('rejects self-links', () => { expect(() => validateRelationInput({ fromId: 'a', toId: 'a', type: 'supersedes' })).toThrow() })
  it('rejects unknown types', () => { expect(() => validateRelationInput({ fromId: 'a', toId: 'b', type: 'x' as any })).toThrow() })
  it('accepts a valid supersedes/contradicts edge', () => {
    expect(validateRelationInput({ fromId: 'a', toId: 'b', type: 'contradicts' })).toEqual({ fromId: 'a', toId: 'b', type: 'contradicts' })
  })
})
```

- [ ] **Step 2: Verify fail** — `pnpm test server/services/memory-relations.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `validateRelationInput` (pure), `createMemoryRelation` (insert into `memory_relations` with `.onConflictDoNothing()`, `status:'active'`; `publishChange({resource:'graph',action:'update',id:fromId})`; return undo token that deletes the row), `deleteMemoryRelation` (flip `status` or delete; publish; undo re-inserts). Reuse the undo-token pattern from `server/services/memory.ts` (`forget`).

- [ ] **Step 4: Endpoints** — thin handlers calling the service (auth-guarded; `readBody` for POST).

- [ ] **Step 5: Verify pass + gates** — `pnpm test && pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/memory-relations.ts server/services/memory-relations.test.ts server/api/memory-relations/
git commit -m "feat(galaxy): manual memory-relation create/delete + undo"
```

---

## Task 3.2: Live `graph` resource + invalidation

**Files:**
- Modify: the `ResourceName` union (locate via `add-live-resource` skill / `.claude/rules/live-data.md`)
- Modify: `server/tasks/compute-graph-layout.ts` (publish `graph` on completion)
- Modify: `app/composables/useGalaxy.ts` (subscribe/invalidate)

- [ ] **Step 1: Add `'graph'`** to the `ResourceName` union.

- [ ] **Step 2: Publish** — at the end of the layout job: `publishChange({ resource: 'graph', action: 'update', id: 'layout' })`.

- [ ] **Step 3: Invalidate** — in `useGalaxy`, on the app's live-event stream, `queryClient.invalidateQueries({ queryKey: ['graph'] })` for events with `resource ∈ {graph, memory, document, image, session, project}`. Follow the existing pattern other pages use to consume `/api/events` (grep `useEventSource`/the live plugin).

- [ ] **Step 4: Typecheck + build** — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(galaxy): live graph resource + query invalidation"
```

---

## Task 3.3: Wire detail-pane CRUD + draw-relation

**Files:**
- Modify: `app/components/galaxy/GalaxyDetail.vue`
- Modify: `app/composables/useGalaxy.ts` (mutations)
- Modify: `app/pages/galaxy.vue` (draw-relation mode + create-node affordance)

**Interfaces:**
- Consumes: existing endpoints — memories (edit/forget/create + review approve/reject), images (edit/delete), documents (edit/move/delete or deep-link), sessions (reassign — cycle 46 `ReassignProjectModal`), projects (edit/merge); relations (3.1); neighbors (2.4).

- [ ] **Step 1: Per-type actions** — render the correct action set by `node.type`:
  - memory → Edit (content/tags/scope), Delete (forget), Show similar (neighbors), Add relation.
  - image → Edit summary/tags, Delete, Show similar.
  - document → Edit metadata / “Open in editor” deep-link, Move project, Delete.
  - session → Edit title/summary, Reassign project (reuse `ReassignProjectModal`).
  - project → Edit name/color, Merge (reuse cycle-27 dialog).
  All call existing endpoints; on success rely on the live `graph` invalidation (3.2) to refresh.

- [ ] **Step 2: Show similar** — call `/api/graph/neighbors?type=&id=&k=8`; temporarily highlight + link the results in the scene (a `scene.highlight(ids)` method — add to `scene.ts`).

- [ ] **Step 3: Draw relation** — from a selected memory: “Add relation” → pick a target (search-to-fly or click another memory) + a type (supersedes/contradicts, non-empty select values) → `POST /api/memory-relations`. A new violet/red edge appears via invalidation.

- [ ] **Step 4: Create node** — a “+ New memory” affordance → create via the memory endpoint; the node appears near its project hub (fallback coords) until the next layout rebuild.

- [ ] **Step 5: Browser E2E (playwright-cli), full**

On `/galaxy` (authed):
- edit a memory’s content → persists → node label/preview updates live.
- delete a memory → node disappears; undo restores.
- draw a supersedes relation between two memories → a violet edge appears; verify a `memory_relations` row exists.
- reassign a session’s project → membership edge re-points.
- Show similar highlights neighbors.
- 0 console errors; reka-ui selects use real clicks.

- [ ] **Step 6: Gates + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
```bash
git add -A
git commit -m "feat(galaxy): full CRUD + draw-relation from the detail pane"
```

**PHASE 3 GATE:** full CRUD works end-to-end in the browser with live updates; all gates green.

---

## Final integration review (before handover)

- [ ] Run the whole suite: `pnpm typecheck && pnpm test && pnpm build && pnpm db:migrate`.
- [ ] Full playwright sweep of `/galaxy` (load → orbit/throw → hover → select → each CRUD path → live refresh).
- [ ] Confirm the layout cron is registered and `POST /api/graph/recompute` works.
- [ ] Write the handover `docs/handovers/2026-07-15-knowledge-galaxy.md` (frontmatter + what shipped/deferred), add `docs/wiki/galaxy.md`, bump the roadmap row (Cycle 47 → shipped) + tick the backlog, and reconcile/close task `e356a621`. Mirror the wiki page to MyMind.

---

## Self-Review (author checklist — completed)

**Spec coverage:** nodes/embedding rule → 1.4 stub + 2.3/2.4; UMAP layout + `graph_layout` → 2.1/2.2/2.4; structural edges → 2.3; on-demand similarity → 2.3 `getNeighbors` + 3.3 Show-similar; arcball/inertia/spring → 1.2/1.3/1.5; control panel defaults → 1.6; color-by-Type default → 1.6; detail pane + full CRUD + draw relations → 3.1/3.3; live → 3.2; three.js/bloom reuse → 1.5; testing (unit + playwright) → per-phase. Covered.

**Placeholders:** DB-query bodies in 2.3/2.4/3.1 are described-not-coded ON PURPOSE — they must follow existing service conventions (`memory.ts`/`documents.ts`), and the pure, load-bearing logic (edges/layout/validation/arcball/spring) is given in full with tests. The scene (1.5) is frontend-design-led against the checked-in prototype. Two deliberate copy-traps (`requireAuth` import, `onБeforeUnmount`) force the implementer to read, not paste.

**Type consistency:** `GraphNode`/`GraphEdge`/`GraphEdgeKind`/`GraphNeighbor` are defined once (1.1) and used verbatim throughout; `GalaxyControlsState` keys (spread/zoom/rotate/size/glow/link) match the composable `controls` and slider defaults; relation `type` values (`supersedes`/`contradicts`) match the schema comment + `assembleEdges` + validation.
