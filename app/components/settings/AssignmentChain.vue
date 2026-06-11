<!-- app/components/settings/AssignmentChain.vue -->
<script setup lang="ts">
import { useSortable } from '@vueuse/integrations/useSortable'

const props = defineProps<{ ids: string[]; labelOf: (id: string) => string; dimOf: (id: string) => number | null }>()
const emit = defineEmits<{ reorder: [ids: string[]]; remove: [id: string] }>()

const el = ref<HTMLElement | null>(null)
// Local mirror sortable mutates; sync down from props, emit up on end.
const list = ref<string[]>([...props.ids])
watch(() => props.ids, (v) => {
  const same = v.length === list.value.length && v.every((id, i) => id === list.value[i])
  if (same) return
  list.value = [...v]
})

useSortable(el, list, {
  animation: 150,
  handle: '.drag-handle',
  onEnd: () => emit('reorder', [...list.value])
})
</script>

<template>
  <div ref="el" class="flex flex-col gap-1.5">
    <div
      v-for="id in list"
      :key="id"
      class="flex items-center gap-2 rounded-md border border-default bg-elevated/40 px-2 py-1.5"
    >
      <UIcon name="i-lucide-grip-vertical" class="drag-handle size-4 cursor-grab text-muted" />
      <span class="flex-1 text-sm">{{ labelOf(id) }}</span>
      <UBadge v-if="dimOf(id)" size="xs" variant="subtle">{{ dimOf(id) }}</UBadge>
      <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" aria-label="Remove model" @click="emit('remove', id)" />
    </div>
    <p v-if="!list.length" class="text-xs text-muted">No models assigned.</p>
  </div>
</template>
