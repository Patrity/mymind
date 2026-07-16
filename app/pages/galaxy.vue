<!-- app/pages/galaxy.vue -->
<!-- 3D knowledge graph rendered inside the DEFAULT dashboard layout: the canvas +
     overlays fill the main content panel (UDashboardPanel), positioned `absolute`
     within the `stage` container rather than `fixed` to the viewport — so the sidebar
     stays visible and the galaxy sizes to the panel (the scene measures the canvas'
     bounding rect). auth.global.ts gates /galaxy by path. -->
<script setup lang="ts">
import { createGalaxyScene, type GalaxyScene } from '~/lib/galaxy/scene'
import type { GalaxyRelationRow } from '~/components/galaxy/GalaxyDetail.vue'
import type { MemoryRelationType } from '~/composables/useGalaxy'
import type { MemoryScope } from '~~/shared/types/memory'
import type { GraphNode } from '~~/shared/types/graph'
import ReassignProjectModal from '~/components/sessions/ReassignProjectModal.vue'

definePageMeta({ title: 'Galaxy' })

const galaxy = useGalaxy()
const { graph, selected, hovered, colorMode, activeKeys, controls } = galaxy
const toast = useToast()
const memories = useMemories()

function toastErr(e: unknown, fallback: string) {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: fallback, description: err?.data?.statusMessage ?? err?.message })
}

watch(graph.error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load the graph', description: e.data?.statusMessage ?? e.message })
})

const canvas = ref<HTMLCanvasElement>()
const stage = ref<HTMLElement>() // positioning context for the absolute overlays
let scene: GalaxyScene | null = null

// Cursor position for the hover tooltip — now STAGE-relative (the tooltip is
// absolute within the content panel, not fixed to the viewport), offset +14px.
const mouseX = ref(-999)
const mouseY = ref(-999)
function onPointerMove(e: PointerEvent) {
  const r = stage.value?.getBoundingClientRect()
  mouseX.value = r ? e.clientX - r.left : e.clientX
  mouseY.value = r ? e.clientY - r.top : e.clientY
}

onMounted(() => {
  scene = createGalaxyScene(canvas.value!)
  galaxy.bindScene(scene)
  scene.onHover(n => (hovered.value = n))
  scene.onSelect(onNodeSelected)
  watch(() => graph.data.value, (d) => {
    if (!d) return
    scene!.setData(d)
    // Keep `selected` in sync across live refetches so the pane shows fresh
    // content (e.g. after an edit), and auto-close it when its node is gone
    // (archived/deleted) — both without a manual reload.
    if (selected.value) {
      const fresh = d.nodes.find(n => n.id === selected.value!.id)
      if (fresh) selected.value = fresh
      else { selected.value = null; scene!.select(null) }
    }
  }, { immediate: true })
  watch(colorMode, m => scene!.setColorMode(m), { immediate: true })
  watch(controls, c => scene!.setControls({ ...c }), { deep: true, immediate: true })
  watch(() => selected.value?.id ?? null, id => scene!.setDetailOpen(!!id))
  // CRITICAL: without this the legend's clicks have nothing to drive — setActiveKeys
  // is the only thing that actually filters layers (isolate model; see GalaxyLegend).
  watch(activeKeys, () => scene!.setActiveKeys(new Set(activeKeys)), { deep: true, immediate: true })
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

// Candidate targets for the draw-relation picker: every other memory node.
const memoryTargets = computed(() => {
  const sel = selected.value?.id
  return (graph.data.value?.nodes ?? [])
    .filter(n => n.type === 'memory' && n.id !== sel)
    .map(n => ({ id: n.id, label: n.label }))
})

// Selecting a node (a click on the canvas, or a fly-to) auto-highlights its semantic
// neighbours — replacing the old "Show similar" button (fix 4b). Projects carry no
// vector, so skip them. Fire-and-forget: a failed similarity fetch must never break
// the selection itself (the node still opens in the detail pane + glows).
async function onNodeSelected(n: GraphNode) {
  selected.value = n
  if (n.type === 'project') return
  try { await galaxy.showSimilar(n) } catch { /* non-fatal: node stays selected, just no neighbours */ }
}

// ── Detail-pane actions (scene-/undo-/modal-coupled; the pane emits, we act) ──
async function onCreateRelation(payload: { toId: string, type: MemoryRelationType }) {
  if (!selected.value) return
  try {
    const result = await galaxy.addRelation(selected.value.id, payload.toId, payload.type)
    if (!result.created) {
      // Same edge already existed — the endpoint no-op'd (no publish, no undo token).
      // Say so plainly rather than showing a false "created" toast with a dead Undo.
      toast.add({ color: 'neutral', icon: 'i-lucide-git-branch', title: 'Relation already exists' })
      return
    }
    toast.add({
      color: 'success',
      icon: 'i-lucide-git-branch',
      title: `Relation created (${payload.type})`,
      actions: [{ label: 'Undo', onClick: () => onUndo(result.undoToken, 'Relation removed') }]
    })
  } catch (e) { toastErr(e, 'Could not create relation') }
}

async function onArchiveMemory() {
  if (!selected.value || selected.value.type !== 'memory') return
  const id = selected.value.id
  try {
    const { undoToken } = await memories.archive(id)
    selected.value = null
    scene?.select(null)
    toast.add({
      color: 'success',
      icon: 'i-lucide-archive',
      title: 'Memory archived',
      actions: undoToken ? [{ label: 'Undo', onClick: () => onUndo(undoToken, 'Memory restored') }] : undefined
    })
  } catch (e) { toastErr(e, 'Archive failed') }
}

async function onUndo(token: string, okTitle: string) {
  try {
    await galaxy.undo(token)
    toast.add({ color: 'neutral', title: okTitle })
  } catch (e) { toastErr(e, 'Undo failed') }
}

// ── Reassign a session's project (reuse the cycle-46 modal) ───────────────────
const reassignOpen = ref(false)
function onReassign() {
  if (selected.value?.type === 'session') reassignOpen.value = true
}

// ── Create memory ─────────────────────────────────────────────────────────────
const createOpen = ref(false)
const creating = ref(false)
const createForm = reactive<{ content: string, scope: MemoryScope, project: string, tagsRaw: string }>({
  content: '', scope: 'user', project: '', tagsRaw: ''
})
const createScopeItems = [
  { label: 'user', value: 'user' },
  { label: 'agent', value: 'agent' },
  { label: 'world', value: 'world' }
]
async function submitCreate() {
  if (!createForm.content.trim()) return
  creating.value = true
  try {
    await memories.create({
      content: createForm.content.trim(),
      scope: createForm.scope,
      project: createForm.project.trim() || null,
      tags: createForm.tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
    })
    toast.add({ color: 'success', icon: 'i-lucide-check', title: 'Memory created', description: 'It joins the galaxy after the next layout rebuild.' })
    createOpen.value = false
    createForm.content = ''
    createForm.project = ''
    createForm.tagsRaw = ''
  } catch (e) { toastErr(e, 'Could not create memory') } finally { creating.value = false }
}

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
  <UDashboardPanel
    id="galaxy"
    grow
    :ui="{ body: '!p-0 relative overflow-hidden' }"
  >
    <template #body>
      <!-- `stage`: the positioning context. The canvas fills it (absolute inset-0),
           the scene measures the canvas' bounding rect, so the galaxy sizes to this
           content panel. Every overlay below is `absolute` within `stage`. -->
      <div
        ref="stage"
        class="absolute inset-0 bg-[#05060c] text-[#e9eaf3] overflow-hidden select-none"
      >
        <canvas
          ref="canvas"
          class="absolute inset-0 h-full w-full"
        />

        <!-- loading veil (first load only) -->
        <div
          v-if="graph.isPending.value"
          class="absolute inset-0 z-30 flex items-center justify-center bg-[#05060c]/70 pointer-events-none"
        >
      <div class="flex items-center gap-2 text-sm text-[#9aa0b8]">
        <UIcon
          name="i-lucide-loader-2"
          class="size-4 animate-spin"
        />
        Loading the galaxy…
      </div>
    </div>

    <!-- top bar (absolute overlay across the panel) -->
    <div class="absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 sm:px-[18px] py-3 bg-gradient-to-b from-[#05060c]/90 to-transparent backdrop-blur-[2px]">
      <UDashboardSidebarCollapse class="shrink-0 -ml-1 text-[#9aa0b8] hover:text-[#e9eaf3]" />
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

      <UButton
        icon="i-lucide-plus"
        label="New memory"
        size="sm"
        variant="soft"
        class="shrink-0 bg-[rgba(167,139,250,.18)] text-[#e9eaf3] hover:bg-[rgba(167,139,250,.3)]"
        @click="createOpen = true"
      />

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
      :active="activeKeys"
      @toggle="galaxy.toggleKey"
    />

    <!-- hint -->
    <div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 text-xs text-[#9aa0b8] bg-[rgba(14,16,26,.72)] border border-white/[0.09] backdrop-blur-xl px-3.5 py-1.5 rounded-full whitespace-nowrap pointer-events-none">
      grab, drag &amp; throw — release to keep spinning · scroll to zoom · click to open
    </div>

    <!-- cursor-following tooltip (stage-relative) -->
    <div
      v-if="hovered"
      class="absolute z-20 pointer-events-none px-[11px] py-2 rounded-[9px] bg-[rgba(10,12,22,.94)] border border-white/[0.09] shadow-2xl max-w-[240px]"
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
      :memory-targets="memoryTargets"
      @close="closeDetail"
      @fly="galaxy.flyTo"
      @create-relation="onCreateRelation"
      @archive-memory="onArchiveMemory"
      @reassign="onReassign"
    />

    <!-- Reassign a session's project (reused cycle-46 modal) -->
    <ReassignProjectModal
      v-if="selected?.type === 'session'"
      v-model:open="reassignOpen"
      :session-ids="[selected.id]"
      :current-cwd="null"
      :current-project="selected.project"
    />

    <!-- Create memory -->
    <UModal
      v-model:open="createOpen"
      title="New memory"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="Content"
            required
          >
            <UTextarea
              v-model="createForm.content"
              placeholder="What do you want to remember?"
              :rows="4"
              autoresize
              autofocus
              class="w-full"
            />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Scope">
              <USelectMenu
                v-model="createForm.scope"
                :items="createScopeItems"
                value-key="value"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Project (optional)">
              <UInput
                v-model="createForm.project"
                placeholder="e.g. mymind"
                class="w-full"
              />
            </UFormField>
          </div>
          <UFormField
            label="Tags (optional)"
            description="Comma-separated"
          >
            <UInput
              v-model="createForm.tagsRaw"
              placeholder="tag1, tag2"
              class="w-full"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            @click="createOpen = false"
          />
          <UButton
            label="Create"
            color="primary"
            icon="i-lucide-check"
            :loading="creating"
            :disabled="!createForm.content.trim()"
            @click="submitCreate"
          />
        </div>
      </template>
    </UModal>
      </div>
    </template>
  </UDashboardPanel>
</template>
