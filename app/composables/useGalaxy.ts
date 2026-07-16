// app/composables/useGalaxy.ts
//
// Reactive state + vue-query fetch backing the /galaxy page. The three.js
// scene itself is an imperative handle (app/lib/galaxy/scene.ts) created by
// the page — it needs the mounted <canvas> element — and registered here via
// `bindScene` so every overlay (search bar, detail pane, legend, …) has one
// call site for `flyTo`/`select` regardless of which one triggers it.
import { useQuery } from '@tanstack/vue-query'
import type { GraphData, GraphNode, GraphNeighbor } from '~~/shared/types/graph'
import type { GalaxyScene } from '~/lib/galaxy/scene'

export type MemoryRelationType = 'supersedes' | 'contradicts'

export function useGalaxy() {
  const graph = useQuery({
    queryKey: ['graph'],
    queryFn: () => $fetch<GraphData>('/api/graph')
  })

  const selected = ref<GraphNode | null>(null)
  const hovered = ref<GraphNode | null>(null)
  const colorMode = ref<'type' | 'project'>('type') // DEFAULT = type
  const disabledKeys = reactive(new Set<string>())
  const controls = reactive({ spread: 1, zoom: 0.9, rotate: 1, size: 1, glow: 1, link: 1 })

  const scene = shallowRef<GalaxyScene | null>(null)
  function bindScene(s: GalaxyScene | null) {
    scene.value = s
  }

  /** Fly the camera to a node (search-to-fly, relation click, …). No-op before the scene mounts. */
  function flyTo(nodeId: string) {
    scene.value?.flyTo(nodeId)
  }
  /** Select (or clear, with null) a node — drives the ring via the scene; pair with clearing `selected` to close the detail pane. */
  function select(nodeId: string | null) {
    scene.value?.select(nodeId)
  }

  /** Legend row click — toggles a type/project key in the disabled set. MUST stay `node.type` (type mode) / `node.project ?? '__none__'` (project mode) to match the scene's setVisibleKeys contract. */
  function toggleKey(key: string) {
    if (disabledKeys.has(key)) disabledKeys.delete(key)
    else disabledKeys.add(key)
  }

  /** Imperatively emphasise a set of nodes in the scene (anchor id first). */
  function highlight(ids: string[]) {
    scene.value?.highlight(ids)
  }

  /**
   * "Show similar" — fetch a node's semantic neighbours and flash them (plus the
   * source) in the scene. Returns the neighbours so the caller can toast a count.
   */
  async function showSimilar(node: GraphNode): Promise<GraphNeighbor[]> {
    const neighbors = await $fetch<GraphNeighbor[]>('/api/graph/neighbors', {
      query: { type: node.type, id: node.id, k: 8 }
    })
    scene.value?.highlight([node.id, ...neighbors.map(n => n.id)])
    return neighbors
  }

  /**
   * Draw a manual supersedes/contradicts edge between two memories. The new edge
   * lands live via the ['graph'] invalidation (the endpoint publishes `graph`).
   * Returns the undoToken so the caller can offer "Undo".
   */
  function addRelation(fromId: string, toId: string, type: MemoryRelationType) {
    return $fetch<{ undoToken: string }>('/api/memory-relations', {
      method: 'POST',
      body: { fromId, toId, type }
    })
  }

  /** Redeem an undo token (relation draw, memory archive, …). */
  function undo(token: string) {
    return $fetch<{ ok: boolean }>('/api/agent/undo', { method: 'POST', body: { token } })
  }

  return { graph, selected, hovered, colorMode, disabledKeys, controls, flyTo, select, bindScene, toggleKey, highlight, showSimilar, addRelation, undo }
}
