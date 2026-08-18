<script setup lang="ts">
import type { TaskColumnDTO } from '~~/shared/types/task-columns'

// Column header: name + card count + an actions menu (Rename, Change colour, Delete).
// "Rename" and "Change colour" both open the same edit form (TasksColumnFormModal already
// combines name + colour in one small form) — no need for two separate dialogs.
//
// The `.column-drag-handle` wrapper (title + badge only, NOT the ellipsis button) is the
// grab target for the board-level column-reorder sortable in tasks.vue — restricting the
// handle keeps the dropdown's ellipsis button independently clickable.
const props = defineProps<{
  column: TaskColumnDTO
  taskCount: number
}>()

const emit = defineEmits<{
  edit: [TaskColumnDTO]
  remove: [TaskColumnDTO]
}>()

const items = computed(() => [[
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => emit('edit', props.column) },
  { label: 'Change colour', icon: 'i-lucide-palette', onSelect: () => emit('edit', props.column) }
], [
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('remove', props.column) }
]])
</script>

<template>
  <div class="flex items-center gap-1 px-1">
    <div class="column-drag-handle flex items-center gap-2 flex-1 min-w-0 cursor-grab active:cursor-grabbing">
      <UIcon
        name="i-lucide-grip-vertical"
        class="size-3.5 text-dimmed shrink-0"
      />
      <span class="text-sm font-semibold text-highlighted truncate">{{ column.name }}</span>
      <UBadge
        :label="String(taskCount)"
        color="neutral"
        variant="soft"
        size="xs"
      />
    </div>

    <UDropdownMenu
      :items="items"
      :content="{ align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="Column actions"
      />
    </UDropdownMenu>
  </div>
</template>
