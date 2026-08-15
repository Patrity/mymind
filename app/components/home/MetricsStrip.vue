<script setup lang="ts">
import type { HomeMetrics, HomeUsage } from '~~/shared/types/home'

const props = defineProps<{ metrics: HomeMetrics, usage: HomeUsage }>()

const fmt = (n: number) => n >= 1_000_000
  ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

const tiles = computed(() => [
  { label: 'Sessions', value: fmt(props.metrics.sessions.total), delta: props.metrics.sessions.delta, to: '/sessions' },
  { label: 'Memories', value: fmt(props.metrics.memories.total), delta: props.metrics.memories.delta, to: '/memories' },
  { label: 'Documents', value: fmt(props.metrics.documents.total), delta: props.metrics.documents.delta, to: '/documents' }
])
</script>

<template>
  <div class="flex gap-3 overflow-x-auto sm:grid sm:grid-cols-2 lg:grid-cols-5 sm:overflow-visible">
    <ULink
      v-for="t in tiles"
      :key="t.label"
      :to="t.to"
      class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
    >
      <p class="text-xl font-semibold text-highlighted">{{ t.value }}</p>
      <p class="text-xs text-muted uppercase tracking-wide">{{ t.label }}</p>
      <p v-if="t.delta > 0" class="text-xs text-primary mt-0.5">+{{ t.delta }} this range</p>
    </ULink>

    <ULink
      to="/analytics"
      class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
    >
      <p class="text-xl font-semibold text-highlighted">{{ fmt(usage.tokens) }}</p>
      <p class="text-xs text-muted uppercase tracking-wide">Tokens</p>
      <!-- Cycle 55: this is API-EQUIVALENT value, never money, never summed with LiteLLM spend.
           Always render the figure (matches UsageTiles.vue's additive pattern) — gating it
           entirely on unpricedModels.length === 0 meant one newly-seen model (or the permanent
           <synthetic> entry) hid the value until the nightly model_prices sync caught up. -->
      <p class="text-xs text-dimmed mt-0.5">
        {{ money(usage.valueUsd) }} at API rates — not billed
      </p>
      <p v-if="usage.unpricedModels.length > 0" class="text-xs text-warning mt-0.5">
        {{ usage.unpricedModels.length }} {{ usage.unpricedModels.length === 1 ? 'model' : 'models' }} unpriced — value pending
      </p>
    </ULink>

    <HomeRigHealth />
  </div>
</template>
