<!-- app/components/settings/AssignmentChain.vue -->
<script setup lang="ts">
import { useSortable } from '@vueuse/integrations/useSortable'

const props = defineProps<{ ids: string[]; labelOf: (id: string) => string; dimOf: (id: string) => number | null }>()
const emit = defineEmits<{ reorder: [ids: string[]]; remove: [id: string] }>()

const el = ref<HTMLElement | null>(null)
// Local mirror that useSortable mutates in place on drop. Sync props -> list
// (down) and emit list -> parent (up) via a watcher — NOT via onEnd: useSortable
// updates `list` after the drop completes, so reading it inside onEnd races and
// emits the pre-drop order (the dragged row "snaps back"). Watching `list`
// (deep, to catch the in-place reorder) fires after the mutation lands. The
// `syncingFromProps` flag stops the prop-driven resync from echoing back up.
const list = ref<string[]>([...props.ids])
let syncingFromProps = false

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

watch(() => props.ids, (v) => {
  if (sameOrder(v, list.value)) return
  syncingFromProps = true
  list.value = [...v]
  nextTick(() => { syncingFromProps = false })
})

useSortable(el, list, { animation: 150, handle: '.drag-handle' })

watch(list, (v) => {
  if (syncingFromProps) return
  if (sameOrder(v, props.ids)) return
  emit('reorder', [...v])
}, { deep: true })
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
