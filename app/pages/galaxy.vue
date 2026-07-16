<!-- app/pages/galaxy.vue -->
<!-- Full-viewport 3D knowledge graph. `layout:false` escapes the dashboard shell
     (sidebar/navbar) — the immersive canvas must fill the real viewport, and
     auth.global.ts gates by path regardless of layout, so this stays protected. -->
<script setup lang="ts">
import { createGalaxyScene, type GalaxyScene } from '~/lib/galaxy/scene'
import type { GalaxyRelationRow } from '~/components/galaxy/GalaxyDetail.vue'

definePageMeta({ title: 'Galaxy', layout: false })

const galaxy = useGalaxy()
const { graph, selected, hovered, colorMode, disabledKeys, controls } = galaxy
const toast = useToast()

watch(graph.error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load the graph', description: e.data?.statusMessage ?? e.message })
})

const canvas = ref<HTMLCanvasElement>()
let scene: GalaxyScene | null = null

// Cursor position (viewport coords) for the hover tooltip — position:fixed, offset +14px like the prototype.
const mouseX = ref(-999)
const mouseY = ref(-999)
function onPointerMove(e: PointerEvent) {
  mouseX.value = e.clientX
  mouseY.value = e.clientY
}

onMounted(() => {
  scene = createGalaxyScene(canvas.value!)
  galaxy.bindScene(scene)
  scene.onHover(n => (hovered.value = n))
  scene.onSelect(n => (selected.value = n))
  watch(() => graph.data.value, d => d && scene!.setData(d), { immediate: true })
  watch(colorMode, m => scene!.setColorMode(m), { immediate: true })
  watch(controls, c => scene!.setControls({ ...c }), { deep: true, immediate: true })
  watch(() => selected.value?.id ?? null, id => scene!.setDetailOpen(!!id))
  // CRITICAL: without this the legend's toggles have nothing to drive — setVisibleKeys
  // is the only thing that actually hides a layer (see GalaxyLegend's header comment).
  watch(disabledKeys, () => scene!.setVisibleKeys(new Set(disabledKeys)), { deep: true, immediate: true })
  window.addEventListener('pointermove', onPointerMove)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  galaxy.bindScene(null)
  scene?.dispose()
})

function closeDetail() {
  scene?.select(null) // hide the ring too, not just the pane
  selected.value = null
}

// Relations for the selected node, derived from the already-loaded graph — no
// extra fetch needed (P1 detail pane is read-only over stub data).
const nodeRelations = computed<GalaxyRelationRow[]>(() => {
  const data = graph.data.value
  const node = selected.value
  if (!data || !node) return []
  const byId = new Map(data.nodes.map(n => [n.id, n]))
  return data.edges
    .filter(e => e.from.id === node.id || e.to.id === node.id)
    .map((e) => {
      const otherRef = e.from.id === node.id ? e.to : e.from
      return { kind: e.kind, otherId: otherRef.id, otherLabel: byId.get(otherRef.id)?.label ?? otherRef.id }
    })
})

// ── Search-to-fly ────────────────────────────────────────────────────────────
const searchQuery = ref('')
function onSearchSubmit() {
  const q = searchQuery.value.trim().toLowerCase()
  const nodes = graph.data.value?.nodes
  if (!q || !nodes) return
  const match = nodes.find(n => n.label.toLowerCase().includes(q)) ?? nodes.find(n => n.id.toLowerCase() === q)
  if (match) galaxy.flyTo(match.id)
  else toast.add({ color: 'neutral', title: 'No match', description: `Nothing found for "${searchQuery.value.trim()}".` })
}
</script>

<template>
  <div class="fixed inset-0 bg-[#05060c] text-[#e9eaf3] overflow-hidden select-none">
    <canvas
      ref="canvas"
      class="fixed inset-0 w-screen h-screen"
    />

    <!-- loading veil (first load only) -->
    <div
      v-if="graph.isPending.value"
      class="fixed inset-0 z-30 flex items-center justify-center bg-[#05060c]/70 pointer-events-none"
    >
      <div class="flex items-center gap-2 text-sm text-[#9aa0b8]">
        <UIcon
          name="i-lucide-loader-2"
          class="size-4 animate-spin"
        />
        Loading the galaxy…
      </div>
    </div>

    <!-- top bar -->
    <div class="fixed top-0 inset-x-0 z-10 flex items-center gap-3 px-4 sm:px-[18px] py-3 bg-gradient-to-b from-[#05060c]/90 to-transparent backdrop-blur-[2px]">
      <div class="flex items-center gap-2 font-semibold tracking-tight text-sm shrink-0">
        <span class="size-4 rounded-full bg-[radial-gradient(circle_at_35%_30%,#c4b5fd,#7c3aed)] shadow-[0_0_14px_#7c3aed]" />
        Galaxy
      </div>

      <UInput
        v-model="searchQuery"
        icon="i-lucide-search"
        placeholder="Search & fly to a node…"
        size="sm"
        class="w-56 sm:w-72 max-w-[42vw]"
        :ui="{ base: 'bg-white/[0.04] border border-white/[0.09] backdrop-blur-xl text-[#e9eaf3] placeholder:text-[#9aa0b8] focus-visible:ring-[#a78bfa]/50' }"
        @keydown.enter="onSearchSubmit"
      />

      <div class="flex-1" />

      <UFieldGroup size="sm">
        <UButton
          label="Type"
          variant="ghost"
          :class="colorMode === 'type' ? 'bg-[rgba(167,139,250,.22)] text-white' : 'text-[#9aa0b8]'"
          @click="colorMode = 'type'"
        />
        <UButton
          label="Project"
          variant="ghost"
          :class="colorMode === 'project' ? 'bg-[rgba(167,139,250,.22)] text-white' : 'text-[#9aa0b8]'"
          @click="colorMode = 'project'"
        />
      </UFieldGroup>
    </div>

    <GalaxyControls v-model="controls" />
    <GalaxyLegend
      :graph="graph.data.value"
      :mode="colorMode"
      :disabled="disabledKeys"
      @toggle="galaxy.toggleKey"
    />

    <!-- hint -->
    <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-10 text-xs text-[#9aa0b8] bg-[rgba(14,16,26,.72)] border border-white/[0.09] backdrop-blur-xl px-3.5 py-1.5 rounded-full whitespace-nowrap pointer-events-none">
      grab, drag &amp; throw — release to keep spinning · scroll to zoom · click to open
    </div>

    <!-- cursor-following tooltip -->
    <div
      v-if="hovered"
      class="fixed z-20 pointer-events-none px-[11px] py-2 rounded-[9px] bg-[rgba(10,12,22,.94)] border border-white/[0.09] shadow-2xl max-w-[240px]"
      :style="{ left: `${mouseX + 14}px`, top: `${mouseY + 14}px` }"
    >
      <div class="text-[10px] tracking-[0.08em] uppercase text-[#9aa0b8]">
        {{ hovered.type === 'project' ? 'Project hub' : hovered.type }}<template v-if="hovered.project && hovered.type !== 'project'">
          · {{ hovered.project }}
        </template>
      </div>
      <div class="text-[#e9eaf3] mt-0.5 leading-[1.35] text-xs">
        {{ hovered.label }}
      </div>
    </div>

    <GalaxyDetail
      v-if="selected"
      :node="selected"
      :relations="nodeRelations"
      @close="closeDetail"
      @fly="galaxy.flyTo"
    />
  </div>
</template>
