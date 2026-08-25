<!-- app/components/documents/TreeRow.vue -->
<script setup lang="ts">
import type { FolderColorSource } from '~~/shared/types/folders'

defineProps<{
  item: {
    id: string
    label: string
    path: string
    nodeType: 'file' | 'folder'
    icon?: string
    color?: string | null
    colorSource?: FolderColorSource | null
  }
  expanded: boolean
  selected: boolean
}>()
</script>

<template>
  <div
    class="flex items-center gap-2 w-full rounded px-1 -mx-1 py-0.5 transition-colors group"
    :class="selected ? 'bg-primary/10 text-default' : 'text-muted'"
  >
    <!-- Colour rail. Inline style because the value is palette DATA (hex), not a theme token —
         it comes from the folder row or the project it inherits from. Files never get a rail. -->
    <span
      v-if="item.nodeType === 'folder'"
      class="w-0.5 h-4 rounded-full shrink-0"
      :style="item.color ? { backgroundColor: item.color } : undefined"
      :class="item.color ? '' : 'bg-transparent'"
    />

    <UIcon
      :name="item.nodeType === 'folder'
        ? (expanded ? 'i-lucide-folder-open' : 'i-lucide-folder')
        : (item.icon ?? 'i-lucide-file')"
      class="size-4 shrink-0"
      :class="item.nodeType === 'folder' && item.color ? '' : 'text-dimmed'"
      :style="item.nodeType === 'folder' && item.color ? { color: item.color } : undefined"
    />

    <span class="truncate text-sm flex-1">{{ item.label }}</span>

    <!-- Drag affordance. Hidden until hover so a static tree stays quiet. Inert for now — Task
         13 wires real drag-and-drop against this exact class (useSortable `handle: '.drag-handle'`). -->
    <UIcon
      name="i-lucide-grip-vertical"
      class="drag-handle size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
    />
  </div>
</template>
