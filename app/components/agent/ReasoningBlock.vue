<!-- app/components/agent/ReasoningBlock.vue -->
<script setup lang="ts">
const props = defineProps<{ reasoning: string; hasAnswer: boolean }>()

// Open while thinking; collapse once the answer begins — unless the user has
// taken manual control of the disclosure.
//
// `userTouched` MUST be driven by a real gesture on the <summary>, NEVER by the
// `toggle` event. `<details>` fires `toggle` for PROGRAMMATIC open/close too, so
// binding intent to it meant Vue's own initial `:open="true"` (which is exactly
// what happens on a live turn, where reasoning arrives before any answer text)
// latched userTouched at mount — and the auto-collapse below could then never
// fire. The block stayed expanded for the rest of the conversation. Resumed
// threads looked fine only because `hasAnswer` is already true there, so `open`
// starts false, Vue never sets the attribute, and no toggle is emitted.
// Keyboard activation of a <summary> dispatches a click, so this covers it too.
const open = ref(!props.hasAnswer)
let userTouched = false
watch(() => props.hasAnswer, (has) => { if (has && !userTouched) open.value = false })
function onSummaryClick() {
  userTouched = true
}
function onToggle(e: Event) {
  // Sync only — carries no intent, because programmatic changes land here as well.
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
      @click="onSummaryClick"
    >
      <UIcon name="i-lucide-brain" class="size-3" />
      Thinking
      <UIcon name="i-lucide-chevron-right" class="size-3 transition-transform group-open:rotate-90" />
    </summary>
    <p class="whitespace-pre-wrap px-2.5 pb-2 pt-0.5 text-xs leading-relaxed text-muted">{{ reasoning }}</p>
  </details>
</template>
