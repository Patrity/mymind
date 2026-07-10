<!-- app/components/agent/ReasoningBlock.vue -->
<script setup lang="ts">
const props = defineProps<{ reasoning: string; hasAnswer: boolean }>()

// Open while thinking; collapse once the answer begins — unless the user has
// taken manual control of the disclosure.
const open = ref(!props.hasAnswer)
let userTouched = false
watch(() => props.hasAnswer, (has) => { if (has && !userTouched) open.value = false })
function onToggle(e: Event) {
  userTouched = true
  open.value = (e.target as HTMLDetailsElement).open
}
</script>

<template>
  <details
    :open="open"
    class="group mb-1 rounded-md border border-default bg-muted/30"
    @toggle="onToggle"
  >
    <summary
      class="flex cursor-pointer select-none list-none items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated/40"
    >
      <UIcon name="i-lucide-brain" class="size-3" />
      Thinking
      <UIcon name="i-lucide-chevron-right" class="size-3 transition-transform group-open:rotate-90" />
    </summary>
    <p class="whitespace-pre-wrap px-2.5 pb-2 pt-0.5 text-xs leading-relaxed text-muted">{{ reasoning }}</p>
  </details>
</template>
