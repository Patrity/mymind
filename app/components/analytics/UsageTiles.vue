<script setup lang="ts">
import type { UsageResponse } from '~~/shared/types/usage'

const props = defineProps<{ usage: UsageResponse | undefined, pending: boolean }>()

const RANGE_LABELS: Record<string, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  all: 'all time',
}

const abbreviate = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}

const currency = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

const tiles = computed(() => {
  const u = props.usage
  if (!u) return []
  return [
    {
      label: 'Total tokens',
      value: abbreviate(u.totals.tokens),
      sub: `${u.totals.cacheReadPct.toFixed(1)}% cache reads`,
    },
    {
      label: 'API-equivalent value',
      value: currency(u.totals.valueUsd),
      sub: 'at API rates — not billed',
    },
    {
      label: 'Agent dispatches',
      value: u.totals.dispatches.toLocaleString(),
      sub: `across ${u.totals.sessions.toLocaleString()} sessions`,
    },
    {
      label: 'Sessions',
      value: u.totals.sessions.toLocaleString(),
      sub: RANGE_LABELS[u.range] ?? u.range,
    },
  ]
})

const unpricedNote = computed(() => {
  const u = props.usage
  if (!u || u.unpriced.tokens <= 0) return null
  return `${u.unpriced.tokens.toLocaleString()} tokens from unpriced models (${u.unpriced.models.join(', ')}) excluded from value`
})
</script>

<template>
  <div class="space-y-2">
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UCard v-for="t in tiles" :key="t.label" :ui="{ body: 'p-3 sm:p-4' }">
        <div class="text-sm font-medium text-highlighted truncate">{{ t.label }}</div>
        <div class="mt-2 text-2xl font-semibold">{{ pending ? '—' : t.value }}</div>
        <div class="mt-1 text-xs text-muted">{{ t.sub }}</div>
      </UCard>
    </div>
    <p v-if="unpricedNote" class="text-xs text-muted">{{ unpricedNote }}</p>
  </div>
</template>
