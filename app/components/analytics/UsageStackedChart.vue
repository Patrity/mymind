<script setup lang="ts">
import { VisXYContainer, VisStackedBar, VisAxis, VisTooltip, VisStackedBarSelectors } from '@unovis/vue'
import type { UsageDayPoint } from '~~/shared/types/usage'

const props = defineProps<{ daily: UsageDayPoint[], models: string[], colorSlots?: Record<string, number> }>()

// dataviz skill categorical palette (references/palette.md) — 8 hues, fixed order,
// validated for both modes. Copied verbatim from TimeSeriesChart.vue (that file
// doesn't export these, so per the task brief they're duplicated here rather than
// re-derived or replaced with a new palette).
const CATEGORICAL_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
const CATEGORICAL_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const palette = computed(() => (isDark.value ? CATEGORICAL_DARK : CATEGORICAL_LIGHT))

// Deterministic model -> palette slot. Two properties are both required:
//  1. Stable per model across a range switch — so NOT a function of position in
//     `props.models`. The page derives `models` from `byModel`, which the server
//     sorts by valueUsd descending — an order that reshuffles on every range
//     switch. Indexing by position would reassign a model's colour whenever the
//     value ranking changed.
//  2. Collision-free whenever the rendered set is <= the palette size. A raw
//     hash alone doesn't guarantee that: verified colliding on this app's real
//     9-model set (`<synthetic>` and `claude-sonnet-4-20250514` both hashed to
//     slot 5; `claude-opus-4-6` and `claude-sonnet-4-6` both hashed to slot 2).
// Fix: sort the labels alphabetically (a criterion that doesn't depend on any
// range-varying rank) and walk them in that order, taking each one's hashed
// slot if free, else linear-probing forward — wrapping, bounded to `mod`
// attempts so it can't spin forever once every slot is taken. Alphabetical
// order is itself stable across range switches, so the resulting assignment
// is too. Beyond `mod` distinct labels collision-free is impossible
// (pigeonhole) — the bounded probe degrades to a deterministic reuse instead
// of hanging.
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

// `props.colorSlots`, when supplied by the page, is the resolution computed once
// over the canonical model set — shared with the "Where the value went" breakdown
// bars so the same model renders in the same colour in both panels (see
// analytics.vue). Falls back to resolving over this component's own `props.models`
// so it still works stand-alone.
const ownSlots = computed(() => resolveColorSlots(props.models, palette.value.length))
const seriesColor = (model: string) => {
  const slot = props.colorSlots?.[model] ?? ownSlots.value[model] ?? hashIndex(model, palette.value.length)
  return palette.value[slot]!
}

// Chart chrome (gridlines/axes/tooltip) — copied verbatim from TimeSeriesChart.vue.
// Unovis's built-in dark-mode CSS selectors (`html.dark-theme` etc.) don't match
// Nuxt's `.dark` class, so these vars are themed explicitly per mode instead of
// relying on Unovis's own dark defaults.
const chromeVars = computed(() => (isDark.value
  ? {
      '--vis-axis-grid-color': '#2c2c2a',
      '--vis-axis-tick-color': '#383835',
      '--vis-axis-tick-label-color': '#898781',
      '--vis-axis-label-color': '#898781',
      '--vis-tooltip-background-color': '#1a1a19',
      '--vis-tooltip-border-color': '#2c2c2a',
      '--vis-tooltip-text-color': '#ffffff'
    }
  : {
      '--vis-axis-grid-color': '#e1e0d9',
      '--vis-axis-tick-color': '#c3c2b7',
      '--vis-axis-tick-label-color': '#898781',
      '--vis-axis-label-color': '#898781',
      '--vis-tooltip-background-color': '#fcfcfb',
      '--vis-tooltip-border-color': '#e1e0d9',
      '--vis-tooltip-text-color': '#0b0b0b'
    }))

// One row per day, indexed 0..n (VisStackedBar's `x` needs a NumericAccessor); the
// day string itself is looked up back out of `days` by index for axis/tooltip labels.
type Row = { i: number } & Record<string, number>

const days = computed(() => props.daily.map(d => d.day))
const rows = computed<Row[]>(() => props.daily.map((d, i) => {
  const row = { i } as Row
  for (const m of props.models) row[m] = d.byModel[m] ?? 0
  return row
}))

const x = (d: Row) => d.i
const yAccessors = computed(() => props.models.map(m => (d: Row) => d[m] ?? 0))
const barColors = computed(() => props.models.map(m => seriesColor(m)))

const abbreviate = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}

const dayLabel = (day: string | undefined): string =>
  day ? new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''

const xTickFormat = (i: number) => dayLabel(days.value[Math.round(i)])

interface BarDatum { datum: Row, stackIndex: number }

// Tooltip content built as real DOM nodes (never innerHTML) — model names come from
// upstream API responses and must go through textContent, not string interpolation,
// per the dataviz skill's untrusted-label rule (same as TimeSeriesChart.vue).
function tooltipTemplate(data: BarDatum): HTMLElement {
  const model = props.models[data.stackIndex]

  const wrap = document.createElement('div')
  wrap.className = 'space-y-1'

  const dayEl = document.createElement('div')
  dayEl.className = 'text-xs text-muted'
  dayEl.textContent = dayLabel(days.value[data.datum.i])
  wrap.appendChild(dayEl)

  const row = document.createElement('div')
  row.className = 'flex items-center gap-1.5 text-xs'

  const swatch = document.createElement('span')
  swatch.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;background:${model ? seriesColor(model) : 'transparent'}`
  row.appendChild(swatch)

  const value = document.createElement('span')
  value.className = 'font-medium text-highlighted'
  value.textContent = model ? abbreviate(data.datum[model] ?? 0) : '—'
  row.appendChild(value)

  const name = document.createElement('span')
  name.className = 'text-muted'
  name.textContent = model ?? ''
  row.appendChild(name)

  wrap.appendChild(row)
  return wrap
}
</script>

<template>
  <UCard :ui="{ body: 'p-3 sm:p-4' }">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-sm font-medium text-highlighted">Daily usage by model</span>
    </div>
    <div v-if="!daily.length" class="flex h-56 items-center justify-center text-sm text-muted">
      No usage in this range
    </div>
    <div v-else :style="chromeVars">
      <VisXYContainer :data="rows" :height="256" aria-label="Daily usage by model">
        <VisStackedBar :x="x" :y="yAccessors" :color="barColors" :bar-padding="0.15" />
        <VisAxis type="x" :x="x" :num-ticks="6" :tick-format="xTickFormat" />
        <VisAxis type="y" :tick-format="abbreviate" :num-ticks="4" />
        <VisTooltip :triggers="{ [VisStackedBarSelectors.bar]: tooltipTemplate }" />
      </VisXYContainer>
    </div>
    <div v-if="daily.length && models.length > 1" class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      <span v-for="m in models" :key="m" class="inline-flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: seriesColor(m) }" />
        {{ m }}
      </span>
    </div>
  </UCard>
</template>
