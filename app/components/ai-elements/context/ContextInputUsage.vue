<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed } from 'vue'
import { useContextValue } from './context'
import TokensWithCost from './TokensWithCost.vue'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

// MyMind patch (cycle 65 Task 0 spike): tokenlens dependency dropped — no
// cost-per-model pricing table, so this shows a token count only.
const { usage } = useContextValue()

const inputTokens = computed(() => usage.value?.inputTokens ?? 0)
</script>

<template>
  <slot v-if="$slots.default" />

  <div
    v-else-if="inputTokens > 0"
    :class="
      cn('flex items-center justify-between text-xs', props.class)
    "
    v-bind="$attrs"
  >
    <span class="text-muted-foreground">Input</span>
    <TokensWithCost :tokens="inputTokens" />
  </div>
</template>
