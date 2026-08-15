<script setup lang="ts">
import type { HomeAttention } from '~~/shared/types/home'

const props = defineProps<{ attention: HomeAttention }>()

// Static class strings — Tailwind scans source text, so a constructed
// `bg-${color}` would be purged from the build and render colourless.
const rows = computed(() => [
  { key: 'errors', n: props.attention.unackedErrors, label: 'errors unacked', to: '/activity', dot: 'bg-error' },
  { key: 'conflicts', n: props.attention.conflicts, label: 'memory conflicts to resolve', to: '/review', dot: 'bg-primary' },
  { key: 'unreviewed', n: props.attention.unreviewedMemories, label: 'memories unreviewed', to: '/memories', dot: 'bg-primary' },
  { key: 'unfiled', n: props.attention.unfiledCaptures, label: 'captures still in /input', to: '/documents', dot: 'bg-success' }
].filter(r => r.n > 0))

const total = computed(() => rows.value.length)
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Needs attention</h2>
        <UBadge
          v-if="total > 0"
          color="error"
          variant="subtle"
          size="sm"
          :label="String(total)"
        />
      </div>
    </template>

    <div
      v-if="rows.length === 0"
      class="flex items-center gap-2 text-sm text-muted"
    >
      <UIcon name="i-lucide-check" class="size-4 text-success" />
      Nothing waiting.
    </div>

    <div v-else class="flex flex-col">
      <ULink
        v-for="r in rows"
        :key="r.key"
        :to="r.to"
        class="flex items-center gap-2 py-1.5 text-sm hover:text-primary transition-colors"
      >
        <!-- Decorative only: the row's visible text ("1 errors unacked") already
             carries the full meaning, so the dot is hidden from the a11y tree
             rather than duplicated via aria-label. -->
        <span class="size-2 rounded-full shrink-0" :class="r.dot" aria-hidden="true" />
        <span class="font-semibold tabular-nums">{{ r.n }}</span>
        <span class="text-muted truncate">{{ r.label }}</span>
      </ULink>
    </div>
  </UCard>
</template>
