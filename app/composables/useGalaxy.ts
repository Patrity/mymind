// app/composables/useGalaxy.ts
//
// Reactive state + vue-query fetch backing the /galaxy page. The three.js
// scene itself is an imperative handle (app/lib/galaxy/scene.ts) created by
// the page — it needs the mounted <canvas> element — and registered here via
// `bindScene` so every overlay (search bar, detail pane, legend, …) has one
// call site for `flyTo`/`select` regardless of which one triggers it.
import { useQuery } from '@tanstack/vue-query'
import type { GraphData, GraphNode } from '~~/shared/types/graph'
import type { GalaxyScene } from '~/lib/galaxy/scene'

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
  function bindScene(s: GalaxyScene | null) { scene.value = s }

  /** Fly the camera to a node (search-to-fly, relation click, …). No-op before the scene mounts. */
  function flyTo(nodeId: string) { scene.value?.flyTo(nodeId) }
  /** Select (or clear, with null) a node — drives the ring via the scene; pair with clearing `selected` to close the detail pane. */
  function select(nodeId: string | null) { scene.value?.select(nodeId) }

  /** Legend row click — toggles a type/project key in the disabled set. MUST stay `node.type` (type mode) / `node.project ?? '__none__'` (project mode) to match the scene's setVisibleKeys contract. */
  function toggleKey(key: string) {
    if (disabledKeys.has(key)) disabledKeys.delete(key)
    else disabledKeys.add(key)
  }

  return { graph, selected, hovered, colorMode, disabledKeys, controls, flyTo, select, bindScene, toggleKey }
}
