<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed } from 'vue'
import { useContextValue } from './context'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const { usedTokens, maxTokens } = useContextValue()

const formatter = new Intl.NumberFormat('en-US', { notation: 'compact' })

// MyMind patch (cycle 65 Task 0 spike): tokenlens dependency dropped (no cost
// pricing table maintained). The footer's no-slot fallback shows the total
// used/max token count instead of a $ cost.
const totalTokensText = computed(
  () => `${formatter.format(usedTokens.value)} / ${formatter.format(maxTokens.value)} tokens`,
)
</script>

<template>
  <div
    :class="
      cn(
        'flex w-full items-center justify-between gap-3 bg-elevated p-3 text-xs',
        props.class,
      )
    "
  >
    <slot v-if="$slots.default" />

    <template v-else>
      <span class="text-muted-foreground">Total tokens</span>
      <span>{{ totalTokensText }}</span>
    </template>
  </div>
</template>
