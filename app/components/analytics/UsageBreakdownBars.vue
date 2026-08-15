<script setup lang="ts">
// Generic horizontal bar breakdown — rendered twice with different data shapes
// (value-by-model, dispatches-by-subagent-type). Keep it shape-agnostic; a caller
// that needs different behavior passes different `rows`/`format`, not a fork of
// this file.
const props = defineProps<{
  title: string
  rows: { label: string, value: number }[]
  format?: (v: number) => string
  colorSlots?: Record<string, number>
}>()

// Copied verbatim from TimeSeriesChart.vue (dataviz skill categorical palette,
// references/palette.md) — not exported from that file, so duplicated here per the
// task brief rather than invented anew.
const CATEGORICAL_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
const CATEGORICAL_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const palette = computed(() => (isDark.value ? CATEGORICAL_DARK : CATEGORICAL_LIGHT))

// Deterministic label -> palette slot, collision-resolved by alphabetical-order
// linear probing — same algorithm and rationale as UsageStackedChart.vue (a raw
// hash alone collides on this app's real model set; alphabetical order is stable
// across range switches, unlike sort-by-value/count rank).
function hashIndex(key: string, mod: number): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return Math.abs(h) % mod
}

function resolveColorSlots(labels: string[], mod: number): Record<string, number> {
  const slots: Record<string, number> = {}
  const used = new Set<number>()
  for (const label of [...labels].sort()) {
    let idx = hashIndex(label, mod)
    let attempts = 0
    while (used.has(idx) && attempts < mod) {
      idx = (idx + 1) % mod
      attempts++
    }
    used.add(idx)
    slots[label] = idx
  }
  return slots
}

// `props.colorSlots`, when supplied by the caller, is a mapping resolved
// elsewhere over a wider label set (e.g. the page resolves it once over the
// canonical model set and passes the same map to UsageStackedChart AND this
// component's "Where the value went" instance, so a model gets the same
// colour in both places even though this panel only renders the priced
// subset). Falls back to resolving over this instance's own rows so the
// component still works stand-alone (e.g. "Fleet composition", which has no
// shared label space with the model panels).
const ownSlots = computed(() => resolveColorSlots(props.rows.map(r => r.label), palette.value.length))
const barColor = (label: string) => {
  const slot = props.colorSlots?.[label] ?? ownSlots.value[label] ?? hashIndex(label, palette.value.length)
  return palette.value[slot]!
}

const sorted = computed(() => [...props.rows].sort((a, b) => b.value - a.value))
const maxValue = computed(() => sorted.value.reduce((m, r) => Math.max(m, r.value), 0))
const fmt = (v: number) => (props.format ? props.format(v) : v.toLocaleString())
// Floor a visible sliver for any nonzero value so small-but-real rows don't render
// as an invisible 0-width bar next to the largest row.
const widthPct = (v: number) => (maxValue.value > 0 ? Math.max((v / maxValue.value) * 100, v > 0 ? 2 : 0) : 0)
</script>

<template>
  <UCard :title="title" :ui="{ body: 'p-3 sm:p-4' }">
    <div v-if="!sorted.length" class="flex h-24 items-center justify-center text-sm text-muted">
      No data
    </div>
    <div v-else class="space-y-2.5">
      <div v-for="r in sorted" :key="r.label" class="space-y-1">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="truncate text-muted">{{ r.label }}</span>
          <span class="shrink-0 font-medium text-highlighted">{{ fmt(r.value) }}</span>
        </div>
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div class="h-full rounded-full" :style="{ width: widthPct(r.value) + '%', background: barColor(r.label) }" />
        </div>
      </div>
    </div>
  </UCard>
</template>
