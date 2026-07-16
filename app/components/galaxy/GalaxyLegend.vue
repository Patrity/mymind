<!-- app/components/galaxy/GalaxyLegend.vue -->
<!-- Color-key legend, bottom-left, mirroring the prototype's `.legend` panel.
     CRITICAL: row keys MUST match scene.ts's setVisibleKeys contract exactly —
     `node.type` in type mode, `node.project ?? '__none__'` in project mode —
     or toggling a row silently fails to filter anything. The palettes below
     are duplicated from app/lib/galaxy/scene.ts (TYPE_COLOR / PROJECT_HUES;
     not exported) so swatches match the rendered node colors. -->
<script setup lang="ts">
import type { GraphData, GraphNodeType } from '~~/shared/types/graph'

const props = defineProps<{
  graph: GraphData | undefined
  mode: 'type' | 'project'
  disabled: Set<string>
}>()

const emit = defineEmits<{ toggle: [key: string] }>()

// Keep in lockstep with scene.ts's TYPE_COLOR / PROJECT_HUES constants.
const TYPE_COLOR: Record<GraphNodeType, string> = {
  memory: '#a78bfa',
  document: '#60a5fa',
  image: '#fbbf24',
  session: '#34d399',
  project: '#f472b6'
}
const TYPE_LABEL: Record<GraphNodeType, string> = {
  memory: 'Memory',
  document: 'Document',
  image: 'Image',
  session: 'Session',
  project: 'Project hub'
}
const TYPE_ORDER: GraphNodeType[] = ['memory', 'document', 'image', 'session', 'project']
const PROJECT_HUES = [
  '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee',
  '#c084fc', '#38bdf8', '#facc15', '#f87171', '#4ade80'
]

interface LegendRow { key: string, label: string, color: string }

const rows = computed<LegendRow[]>(() => {
  if (props.mode === 'type') {
    return TYPE_ORDER.map(t => ({ key: t, label: TYPE_LABEL[t], color: TYPE_COLOR[t] }))
  }
  // Same derivation as scene.ts setData: unique project keys, sorted, cycled through PROJECT_HUES.
  const slugs = Array.from(new Set((props.graph?.nodes ?? []).map(n => n.project ?? '__none__'))).sort()
  return slugs.map((slug, i) => ({
    key: slug,
    label: slug === '__none__' ? 'No project' : slug,
    color: PROJECT_HUES[i % PROJECT_HUES.length]!
  }))
})
</script>

<template>
  <div class="fixed left-4 sm:left-[18px] bottom-4 z-10 flex flex-col gap-1.5 px-3.5 py-3 rounded-xl bg-[rgba(14,16,26,.72)] border border-white/[0.09] backdrop-blur-xl text-xs text-[#9aa0b8] max-h-[40vh] overflow-y-auto">
    <b class="text-[11px] font-semibold tracking-[0.08em] uppercase text-[#e9eaf3]">
      {{ mode === 'type' ? 'Type' : 'Project' }}
    </b>
    <button
      v-for="row in rows"
      :key="row.key"
      type="button"
      class="flex items-center gap-2 py-0.5 transition-opacity duration-150 cursor-pointer hover:opacity-100"
      :class="disabled.has(row.key) ? 'opacity-35' : 'opacity-100'"
      @click="emit('toggle', row.key)"
    >
      <span
        class="size-2.5 rounded-full shrink-0"
        :style="{ background: row.color, boxShadow: `0 0 8px ${row.color}` }"
      />
      <span class="truncate max-w-[150px] text-left">{{ row.label }}</span>
    </button>
  </div>
</template>
