<!-- app/components/galaxy/GalaxyDetail.vue -->
<!-- Right-side detail pane — READ-ONLY in Phase 1 (stub /api/graph has no tags/
     scope/confidence; CRUD + those fields land in Phase 3 once the pane is wired
     to the real memory/document/image services). Structurally mirrors the
     prototype's `.detail` aside: pill, title, meta grid, tags, relations, actions. -->
<script setup lang="ts">
import type { GraphEdgeKind, GraphNode, GraphNodeType } from '~~/shared/types/graph'

export interface GalaxyRelationRow {
  kind: GraphEdgeKind
  otherId: string
  otherLabel: string
}

const props = defineProps<{
  node: GraphNode
  relations: GalaxyRelationRow[]
}>()

const emit = defineEmits<{ close: [], fly: [nodeId: string] }>()

const toast = useToast()

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

const meta = computed(() => [
  { k: 'Project', v: props.node.project ?? '—' },
  { k: 'Degree', v: String(props.node.degree) },
  { k: 'Node ID', v: props.node.id }
])

function notYet(feature: string) {
  toast.add({ color: 'neutral', title: 'Not yet available', description: `${feature} arrives with the real backend (Phase 2/3).` })
}
</script>

<template>
  <aside class="fixed top-0 right-0 bottom-0 z-[15] w-[372px] max-w-[88vw] bg-[rgba(14,16,26,.72)] backdrop-blur-2xl border-l border-white/[0.09] px-5 pb-5 pt-16 overflow-y-auto">
    <span class="inline-flex items-center gap-1.5 text-[11px] tracking-[0.06em] uppercase text-white px-2.5 py-1 rounded-full bg-[rgba(167,139,250,.25)] border border-[rgba(167,139,250,.4)]">
      <UIcon :name="TYPE_ICON[node.type]" class="size-3" />
      {{ TYPE_LABEL[node.type] }}
    </span>

    <h2 class="text-[15px] my-3.5 leading-[1.4] text-[#e9eaf3]">
      {{ node.label }}
    </h2>
    <p
      v-if="node.preview"
      class="text-xs text-[#9aa0b8] leading-relaxed -mt-2 mb-3.5"
    >
      {{ node.preview }}
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

    <div class="text-[11px] tracking-[0.09em] uppercase text-[#9aa0b8] mt-4.5 mb-2">
      Tags
    </div>
    <p class="text-xs text-[#9aa0b8] italic">
      No tags yet — coming with the real backend.
    </p>

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

    <div class="flex flex-wrap gap-2 mt-5">
      <UButton
        label="Edit"
        icon="i-lucide-pencil"
        size="sm"
        color="primary"
        variant="soft"
        @click="notYet('Editing')"
      />
      <UButton
        label="Show similar"
        icon="i-lucide-sparkles"
        size="sm"
        color="neutral"
        variant="soft"
        @click="notYet('Similarity search')"
      />
      <UButton
        label="Add relation"
        icon="i-lucide-plus"
        size="sm"
        color="neutral"
        variant="soft"
        @click="notYet('Relation editing')"
      />
      <UButton
        label="Delete"
        icon="i-lucide-trash-2"
        size="sm"
        color="error"
        variant="soft"
        @click="notYet('Deletion')"
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
