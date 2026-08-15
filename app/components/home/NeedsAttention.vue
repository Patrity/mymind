<script setup lang="ts">
import type { HomeAttention } from '~~/shared/types/home'

const props = defineProps<{ attention: HomeAttention }>()

// Static class strings — Tailwind scans source text, so a constructed
// `bg-${color}` would be purged from the build and render colourless.
// Each row carries an explicit singular/plural pair — `n === 1` picks `one`,
// otherwise `many` — so "1 errors unacked" never ships. Irregulars (memory
// conflict/conflicts, memory/memories, capture/captures) are spelled out
// rather than derived with a naive `+ 's'`.
const rows = computed(() => [
  { key: 'errors', n: props.attention.unackedErrors, one: 'error unacked', many: 'errors unacked', to: '/activity', dot: 'bg-error' },
  { key: 'conflicts', n: props.attention.conflicts, one: 'memory conflict to resolve', many: 'memory conflicts to resolve', to: '/review', dot: 'bg-primary' },
  { key: 'unreviewed', n: props.attention.unreviewedMemories, one: 'memory unreviewed', many: 'memories unreviewed', to: '/memories', dot: 'bg-primary' },
  { key: 'unfiled', n: props.attention.unfiledCaptures, one: 'capture still in /input', many: 'captures still in /input', to: '/documents', dot: 'bg-success' }
].filter(r => r.n > 0))

// Header badge is the SUM of outstanding items, not the count of non-zero
// categories — this panel exists because a quiet-looking badge let 71
// unacked errors hide for nine days. Two categories with 71 and 3 items must
// read "74", not "2".
const totalItems = computed(() => rows.value.reduce((sum, r) => sum + r.n, 0))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Needs attention</h2>
        <UBadge
          v-if="totalItems > 0"
          color="error"
          variant="subtle"
          size="sm"
          :label="String(totalItems)"
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
        <!-- Decorative only: the row's visible text ("1 error unacked") already
             carries the full meaning, so the dot is hidden from the a11y tree
             rather than duplicated via aria-label. -->
        <span class="size-2 rounded-full shrink-0" :class="r.dot" aria-hidden="true" />
        <span class="font-semibold tabular-nums">{{ r.n }}</span>
        <span class="text-muted truncate">{{ r.n === 1 ? r.one : r.many }}</span>
      </ULink>
    </div>
  </UCard>
</template>
