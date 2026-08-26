<!-- app/components/documents/TreeRow.vue -->
<script setup lang="ts">
import type { FolderColorSource } from '~~/shared/types/folders'

withDefaults(defineProps<{
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
  /** Part of a cmd/shift multi-selection (Tree.vue) — a drag carries the whole set. */
  marked?: boolean
  /** Folders only: this is the folder the in-flight drag would drop INTO. Task 9's review
   *  noted the folder icon lost its drag-over highlight when the row moved here; it is
   *  restored as a *destination* cue (open icon + ring) now that Tree.vue owns the drag and
   *  can say which folder actually receives the drop, rather than tinting any hovered row. */
  dropActive?: boolean
}>(), { marked: false, dropActive: false })
</script>

<template>
  <div
    class="flex items-center gap-2 w-full rounded px-1 -mx-1 py-0.5 transition-colors group"
    :class="[
      selected || marked ? 'bg-primary/10 text-default' : 'text-muted',
      dropActive ? 'ring-1 ring-primary/50 bg-primary/5' : ''
    ]"
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
        ? ((expanded || dropActive) ? 'i-lucide-folder-open' : 'i-lucide-folder')
        : (item.icon ?? 'i-lucide-file')"
      class="size-4 shrink-0"
      :class="item.nodeType === 'folder' && item.color ? '' : (dropActive ? 'text-primary' : 'text-dimmed')"
      :style="item.nodeType === 'folder' && item.color ? { color: item.color } : undefined"
    />

    <span class="truncate text-sm flex-1">{{ item.label }}</span>

    <!-- Drag affordance — and the ONLY place a drag can start from: Tree.vue configures
         Sortable with `handle: '.drag-handle'`, so dragging the row body never begins a drag
         (it would fight click-to-select and text selection). Hidden until hover so a static
         tree stays quiet. -->
    <UIcon
      name="i-lucide-grip-vertical"
      class="drag-handle size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
    />
  </div>
</template>
