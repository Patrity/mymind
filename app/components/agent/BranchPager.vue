<!-- app/components/agent/BranchPager.vue -->
<!-- The ‹ n/N › control for switching between sibling branches of a message. Task 7 (cycle 68).
     Investigated using the vendored AI Elements MessageBranchPrevious/Page/Next (LOOK reference
     only): they `inject` a MessageBranchKey via `useMessageBranchContext()` (see
     app/components/ai-elements/message/context.ts) and THROW if no ancestor `<MessageBranch>`
     provided it — so the brief's Step 1 snippet, used bare, crashes at setup. Even wrapped in a
     `<MessageBranch>`, that provider tracks branch count from slotted VNodes (client-side
     variants) and its `disabled` state is a single `totalBranches <= 1` shared by both arrows —
     it has no concept of a per-end clamp (ours: previous disabled at index <= 1, next at
     index >= total) and no `disabled` prop of its own to drive from outside. None of that fits a
     server-side pager where only the active branch is ever fetched (same call cycle 67 made
     about PromptInput), and the brief says not to add a provider just for styling. So this uses
     the brief's own fallback: three plain UButtons, which support `:disabled` natively. -->
<script setup lang="ts">
const props = defineProps<{ index: number, total: number }>()
const emit = defineEmits<{ go: [dir: -1 | 1] }>()
</script>

<template>
  <div v-if="props.total > 1" class="flex items-center gap-0.5" data-branch-pager>
    <UButton
      icon="i-lucide-chevron-left"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Previous branch"
      :disabled="props.index <= 1"
      @click="emit('go', -1)"
    />
    <span class="text-[10px] text-dimmed tabular-nums">{{ props.index }}/{{ props.total }}</span>
    <UButton
      icon="i-lucide-chevron-right"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Next branch"
      :disabled="props.index >= props.total"
      @click="emit('go', 1)"
    />
  </div>
</template>
