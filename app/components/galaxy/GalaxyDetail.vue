<!-- app/components/galaxy/GalaxyDetail.vue -->
<!-- Right-side detail pane — INTERACTIVE (Task 3.3). Per-type action sets wired
     to the real services: memory (inline edit content/scope/tags · archive ·
     add relation · show similar), image/document (show similar · deep-link edit
     · delete), session (reassign project · deep-link · show similar), project
     (deep-link edit). Scene-coupled + undo-coupled actions (show similar, add
     relation, archive, reassign) are emitted to the page which owns the galaxy
     handle + modal; plain no-undo edits/deletes run in-pane with a toast. Live
     refresh is automatic — every mutation publishes a change that invalidates
     the ['graph'] query (see .claude/rules/live-data.md).

     The galaxy surface deliberately keeps its own cosmic palette (raw hex) rather
     than the app tokens — the established convention for this immersive canvas.
     The pane is `absolute` within the galaxy stage (the content panel), not `fixed`. -->
<script setup lang="ts">
import type { GraphEdgeKind, GraphNode, GraphNodeType } from '~~/shared/types/graph'
import type { MemoryDTO, MemoryScope } from '~~/shared/types/memory'
import type { MemoryRelationType } from '~/composables/useGalaxy'

export interface GalaxyRelationRow {
  kind: GraphEdgeKind
  otherId: string
  otherLabel: string
}

const props = defineProps<{
  node: GraphNode
  relations: GalaxyRelationRow[]
  /** Other memory nodes, for the draw-relation target picker. */
  memoryTargets: { id: string, label: string }[]
}>()

const emit = defineEmits<{
  close: []
  fly: [nodeId: string]
  'create-relation': [payload: { toId: string, type: MemoryRelationType }]
  'archive-memory': []
  reassign: []
}>()

const toast = useToast()
const memories = useMemories()
const images = useImages()
const documents = useDocuments()

const TYPE_ICON: Record<GraphNodeType, string> = {
  memory: 'i-lucide-brain',
  document: 'i-lucide-files',
  image: 'i-lucide-image',
  session: 'i-lucide-history',
  project: 'i-lucide-folder-kanban'
}
const TYPE_LABEL: Record<GraphNodeType, string> = {
  memory: 'Memory',
  document: 'Document',
  image: 'Image',
  session: 'Session',
  project: 'Project hub'
}

const REL_STYLE: Record<GraphEdgeKind, { label: string, class: string }> = {
  membership: { label: 'member of', class: 'bg-white/[0.06] text-[#cfd3e6]' },
  provenance: { label: 'provenance', class: 'bg-white/[0.06] text-[#cfd3e6]' },
  ocr: { label: 'ocr source', class: 'bg-white/[0.06] text-[#cfd3e6]' },
  supersedes: { label: 'supersedes', class: 'bg-[rgba(167,139,250,.22)] text-[#c4b5fd]' },
  contradicts: { label: 'contradicts', class: 'bg-[rgba(251,113,133,.2)] text-[#fda4af]' }
}

const SCOPE_ITEMS = [
  { label: 'user', value: 'user' },
  { label: 'agent', value: 'agent' },
  { label: 'world', value: 'world' }
]
const REL_TYPE_ITEMS = [
  { label: 'supersedes', value: 'supersedes' },
  { label: 'contradicts', value: 'contradicts' }
]

const isMemory = computed(() => props.node.type === 'memory')

// ── Full memory row (accurate content + tags; the graph label is truncated) ──
const memDetail = ref<MemoryDTO | null>(null)
const memLoading = ref(false)

async function loadMemory() {
  memDetail.value = null
  if (!isMemory.value) return
  memLoading.value = true
  try {
    memDetail.value = await memories.get(props.node.id)
  } catch {
    memDetail.value = null // fall back to the truncated node preview
  } finally {
    memLoading.value = false
  }
}

// ── UI mode + forms ──────────────────────────────────────────────────────────
type Panel = 'none' | 'edit' | 'relate'
const panel = ref<Panel>('none')
const confirmingDelete = ref(false)
const busy = ref(false)

const editForm = reactive<{ content: string, scope: MemoryScope, tags: string[] }>({
  content: '', scope: 'user', tags: []
})
const relForm = reactive<{ toId: string, type: MemoryRelationType }>({ toId: '', type: 'supersedes' })

// Reset everything when the selected node changes.
watch(() => props.node.id, () => {
  panel.value = 'none'
  confirmingDelete.value = false
  relForm.toId = ''
  relForm.type = 'supersedes'
  loadMemory()
}, { immediate: true })

const displayTitle = computed(() => (isMemory.value && memDetail.value ? memDetail.value.content : props.node.label))
const displayPreview = computed(() => {
  if (isMemory.value && memDetail.value) return null // full content already shown in the title
  return props.node.preview ?? null
})
const displayTags = computed(() => (isMemory.value ? (memDetail.value?.tags ?? []) : []))

const meta = computed(() => {
  const rows = [{ k: 'Project', v: props.node.project ?? '—' }, { k: 'Degree', v: String(props.node.degree) }]
  if (isMemory.value && memDetail.value) rows.push({ k: 'Scope', v: memDetail.value.scope })
  rows.push({ k: 'Node ID', v: props.node.id })
  return rows
})

function errText(e: unknown, fallback: string) {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err?.data?.statusMessage ?? err?.message ?? fallback
}

// ── Memory: inline edit ──────────────────────────────────────────────────────
function openEdit() {
  editForm.content = memDetail.value?.content ?? props.node.preview ?? props.node.label
  editForm.scope = memDetail.value?.scope ?? 'user'
  editForm.tags = [...(memDetail.value?.tags ?? [])]
  confirmingDelete.value = false
  panel.value = 'edit'
}

async function saveEdit() {
  if (!editForm.content.trim()) return
  busy.value = true
  try {
    const updated = await memories.patch(props.node.id, {
      content: editForm.content.trim(),
      scope: editForm.scope,
      tags: editForm.tags
    })
    memDetail.value = updated // reflect immediately; graph label refreshes live via SSE
    toast.add({ color: 'success', title: 'Memory updated', icon: 'i-lucide-check' })
    panel.value = 'none'
  } catch (e) {
    toast.add({ color: 'error', title: 'Update failed', description: errText(e, 'Could not update the memory.') })
  } finally {
    busy.value = false
  }
}

// ── Memory: draw relation (emit → page owns the undo toast) ──────────────────
function openRelate() {
  relForm.toId = ''
  relForm.type = 'supersedes'
  confirmingDelete.value = false
  panel.value = 'relate'
}
function submitRelation() {
  if (!relForm.toId) return
  emit('create-relation', { toId: relForm.toId, type: relForm.type })
  panel.value = 'none'
}

// ── Delete (image/document inline with confirm; memory archive → page) ───────
async function confirmDelete() {
  if (!confirmingDelete.value) { confirmingDelete.value = true; return }
  busy.value = true
  try {
    if (props.node.type === 'image') await images.remove(props.node.id)
    else if (props.node.type === 'document') await documents.remove(props.node.id)
    toast.add({ color: 'success', title: `${TYPE_LABEL[props.node.type]} deleted` })
    emit('close')
  } catch (e) {
    toast.add({ color: 'error', title: 'Delete failed', description: errText(e, 'Could not delete.') })
  } finally {
    busy.value = false
    confirmingDelete.value = false
  }
}

// Deep-link targets for heavy edits we don't rebuild in the pane.
const editLink = computed(() => {
  switch (props.node.type) {
    case 'document': return `/documents?doc=${props.node.id}`
    case 'image': return `/gallery?image=${props.node.id}`
    case 'session': return `/sessions/${props.node.id}`
    case 'project': return props.node.project ? `/projects/${props.node.project}` : '/projects'
    default: return null
  }
})
const editLinkLabel = computed(() => (props.node.type === 'project' ? 'Edit project' : props.node.type === 'session' ? 'Open session' : 'Open in editor'))
</script>

<template>
  <aside class="absolute top-0 right-0 bottom-0 z-[15] w-[372px] max-w-[88vw] bg-[rgba(14,16,26,.72)] backdrop-blur-2xl border-l border-white/[0.09] px-5 pb-5 pt-16 overflow-y-auto">
    <span class="inline-flex items-center gap-1.5 text-[11px] tracking-[0.06em] uppercase text-white px-2.5 py-1 rounded-full bg-[rgba(167,139,250,.25)] border border-[rgba(167,139,250,.4)]">
      <UIcon
        :name="TYPE_ICON[node.type]"
        class="size-3"
      />
      {{ TYPE_LABEL[node.type] }}
    </span>

    <h2 class="text-[15px] my-3.5 leading-[1.4] text-[#e9eaf3] whitespace-pre-wrap break-words">
      {{ displayTitle }}
    </h2>
    <p
      v-if="displayPreview"
      class="text-xs text-[#9aa0b8] leading-relaxed -mt-2 mb-3.5"
    >
      {{ displayPreview }}
    </p>

    <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 my-4 text-xs">
      <template
        v-for="row in meta"
        :key="row.k"
      >
        <span class="text-[#9aa0b8]">{{ row.k }}</span>
        <span class="text-[#e9eaf3] truncate font-mono">{{ row.v }}</span>
      </template>
    </div>

    <!-- Tags (memory only — real values from the loaded row) -->
    <template v-if="isMemory">
      <div class="text-[11px] tracking-[0.09em] uppercase text-[#9aa0b8] mt-4.5 mb-2">
        Tags
      </div>
      <div
        v-if="displayTags.length"
        class="flex flex-wrap gap-1.5"
      >
        <span
          v-for="t in displayTags"
          :key="t"
          class="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.09] text-[#cfd3e6]"
        >{{ t }}</span>
      </div>
      <p
        v-else
        class="text-xs text-[#9aa0b8] italic"
      >
        {{ memLoading ? 'Loading…' : 'No tags.' }}
      </p>
    </template>

    <!-- Relations -->
    <div class="text-[11px] tracking-[0.09em] uppercase text-[#9aa0b8] mt-4.5 mb-2">
      Relations · {{ relations.length }}
    </div>
    <p
      v-if="relations.length === 0"
      class="text-xs text-[#9aa0b8] italic"
    >
      No relations for this node.
    </p>
    <button
      v-for="rel in relations"
      :key="`${rel.kind}-${rel.otherId}`"
      type="button"
      class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.09] text-xs mb-1.5 cursor-pointer hover:bg-white/[0.08] transition-colors text-left"
      @click="emit('fly', rel.otherId)"
    >
      <span
        class="text-[10px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded shrink-0"
        :class="REL_STYLE[rel.kind].class"
      >{{ REL_STYLE[rel.kind].label }}</span>
      <span class="truncate text-[#cfd3e6]">{{ rel.otherLabel }}</span>
    </button>

    <!-- ── Inline edit panel (memory) ─────────────────────────────────────── -->
    <div
      v-if="panel === 'edit'"
      class="mt-5 p-3 rounded-xl bg-white/[0.04] border border-[rgba(167,139,250,.28)] space-y-3"
    >
      <div class="text-[11px] tracking-[0.09em] uppercase text-[#c4b5fd]">
        Edit memory
      </div>
      <UTextarea
        v-model="editForm.content"
        :rows="4"
        autoresize
        placeholder="Memory content…"
        class="w-full"
        :ui="{ base: 'bg-white/[0.04] border border-white/[0.09] text-[#e9eaf3] placeholder:text-[#9aa0b8] focus-visible:ring-[#a78bfa]/50' }"
      />
      <div class="grid grid-cols-2 gap-2">
        <UFormField
          label="Scope"
          :ui="{ label: 'text-[#9aa0b8] text-[11px]' }"
        >
          <USelectMenu
            v-model="editForm.scope"
            :items="SCOPE_ITEMS"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="Tags"
          :ui="{ label: 'text-[#9aa0b8] text-[11px]' }"
        >
          <UInputTags
            v-model="editForm.tags"
            placeholder="Add tag…"
            class="w-full"
          />
        </UFormField>
      </div>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="panel = 'none'"
        />
        <UButton
          label="Save"
          size="sm"
          color="primary"
          icon="i-lucide-check"
          :loading="busy"
          :disabled="!editForm.content.trim()"
          @click="saveEdit"
        />
      </div>
    </div>

    <!-- ── Draw-relation panel (memory) ───────────────────────────────────── -->
    <div
      v-else-if="panel === 'relate'"
      class="mt-5 p-3 rounded-xl bg-white/[0.04] border border-[rgba(167,139,250,.28)] space-y-3"
    >
      <div class="text-[11px] tracking-[0.09em] uppercase text-[#c4b5fd]">
        Draw relation
      </div>
      <UFormField
        label="Type"
        :ui="{ label: 'text-[#9aa0b8] text-[11px]' }"
      >
        <USelectMenu
          v-model="relForm.type"
          :items="REL_TYPE_ITEMS"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField
        label="Target memory"
        :ui="{ label: 'text-[#9aa0b8] text-[11px]' }"
      >
        <USelectMenu
          v-model="relForm.toId"
          :items="memoryTargets"
          value-key="id"
          label-key="label"
          searchable
          placeholder="Search a memory…"
          class="w-full"
        />
      </UFormField>
      <p class="text-[11px] text-[#9aa0b8] leading-snug">
        A new {{ relForm.type === 'supersedes' ? 'violet' : 'red' }} edge appears in the graph. You can undo it from the toast.
      </p>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          size="sm"
          color="neutral"
          variant="ghost"
          @click="panel = 'none'"
        />
        <UButton
          label="Create relation"
          size="sm"
          color="primary"
          icon="i-lucide-git-branch"
          :disabled="!relForm.toId"
          @click="submitRelation"
        />
      </div>
    </div>

    <!-- ── Per-type action set (view mode) ────────────────────────────────── -->
    <div
      v-else
      class="flex flex-wrap gap-2 mt-5"
    >
      <!-- memory -->
      <template v-if="node.type === 'memory'">
        <UButton
          label="Edit"
          icon="i-lucide-pencil"
          size="sm"
          color="primary"
          variant="soft"
          :loading="memLoading"
          @click="openEdit"
        />
        <UButton
          label="Add relation"
          icon="i-lucide-git-branch"
          size="sm"
          color="neutral"
          variant="soft"
          @click="openRelate"
        />
      </template>

      <!-- session -->
      <UButton
        v-if="node.type === 'session'"
        label="Reassign project"
        icon="i-lucide-folder-input"
        size="sm"
        color="primary"
        variant="soft"
        @click="emit('reassign')"
      />

      <!-- deep-link edit (document / image / session / project) -->
      <UButton
        v-if="editLink"
        :label="editLinkLabel"
        icon="i-lucide-external-link"
        size="sm"
        color="neutral"
        variant="soft"
        :to="editLink"
      />

      <!-- delete: memory → archive (emit, undoable); image/document → inline confirm -->
      <UButton
        v-if="node.type === 'memory'"
        label="Delete"
        icon="i-lucide-trash-2"
        size="sm"
        color="error"
        variant="soft"
        @click="emit('archive-memory')"
      />
      <UButton
        v-else-if="node.type === 'image' || node.type === 'document'"
        :label="confirmingDelete ? 'Confirm delete' : 'Delete'"
        :icon="confirmingDelete ? 'i-lucide-alert-triangle' : 'i-lucide-trash-2'"
        size="sm"
        color="error"
        :variant="confirmingDelete ? 'solid' : 'soft'"
        :loading="busy"
        @click="confirmDelete"
      />
    </div>

    <UButton
      label="Close"
      color="neutral"
      variant="outline"
      block
      class="mt-4"
      @click="emit('close')"
    />
  </aside>
</template>
