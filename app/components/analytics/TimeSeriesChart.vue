<script setup lang="ts">
import { VisXYContainer, VisLine, VisAxis, VisCrosshair, VisTooltip } from '@unovis/vue'
import type { RangeKey } from '~~/shared/types/analytics'

const props = defineProps<{
  panel: string
  range: RangeKey
  title: string
  unit?: string
  format?: (v: number) => string
}>()

const { useSeries } = useAnalytics()
const { data, error, isPending } = useSeries(props.panel, () => props.range)

const pivoted = computed(() => pivotSeries(data.value?.series ?? []))

// dataviz skill categorical palette (references/palette.md) — 8 hues, fixed order,
// validated for both modes with scripts/validate_palette.js (light: worst adjacent
// CVD dE 24.2; dark: 10.3, floor band). One array drives lines + crosshair dots +
// legend swatches so they can never drift from each other.
const CATEGORICAL_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
const CATEGORICAL_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const palette = computed(() => (isDark.value ? CATEGORICAL_DARK : CATEGORICAL_LIGHT))
const seriesColor = (i: number) => palette.value[i % palette.value.length]!
const lineColors = computed(() => pivoted.value.keys.map((_, i) => seriesColor(i)))

// Chart chrome (gridlines/axes/crosshair/tooltip) from the same palette.md tokens.
// Unovis's built-in dark-mode CSS selectors (`html.dark-theme` etc.) don't match
// Nuxt's `.dark` class, so theme these vars explicitly per mode rather than relying
// on Unovis's own dark defaults.
const chromeVars = computed(() => (isDark.value
  ? {
      '--vis-axis-grid-color': '#2c2c2a',
      '--vis-axis-tick-color': '#383835',
      '--vis-axis-tick-label-color': '#898781',
      '--vis-axis-label-color': '#898781',
      '--vis-crosshair-line-stroke-color': '#898781',
      '--vis-crosshair-circle-stroke-color': '#1a1a19',
      '--vis-crosshair-circle-stroke-width': '2px',
      '--vis-tooltip-background-color': '#1a1a19',
      '--vis-tooltip-border-color': '#2c2c2a',
      '--vis-tooltip-text-color': '#ffffff'
    }
  : {
      '--vis-axis-grid-color': '#e1e0d9',
      '--vis-axis-tick-color': '#c3c2b7',
      '--vis-axis-tick-label-color': '#898781',
      '--vis-axis-label-color': '#898781',
      '--vis-crosshair-line-stroke-color': '#898781',
      '--vis-crosshair-circle-stroke-color': '#fcfcfb',
      '--vis-crosshair-circle-stroke-width': '2px',
      '--vis-tooltip-background-color': '#fcfcfb',
      '--vis-tooltip-border-color': '#e1e0d9',
      '--vis-tooltip-text-color': '#0b0b0b'
    }))

const x = (d: Record<string, number | null>) => d.t as number
// null -> undefined: Unovis treats null as defined (isFinite(null) === true) and
// draws a gap as a dip to zero; undefined breaks the line. Real 0 survives `??`.
const yAccessors = computed(() => pivoted.value.keys.map(k => (d: Record<string, number | null>) => d[k] ?? undefined))

const fmt = (v: number) => {
  if (props.format) return props.format(v)
  const rounded = Math.round(v * 10) / 10
  return `${rounded.toLocaleString()}${props.unit ?? ''}`
}

// "Value at the end" (marks-and-anatomy.md) — also the contrast-WARN relief for the
// two light-mode categorical slots that sit below 3:1 (aqua, yellow): the legend
// keys the color to a name AND a value so identity never depends on eyeballing a
// pale line against the surface.
const latest = (k: string): string => {
  const rows = pivoted.value.rows
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]![k]
    if (v != null) return fmt(v)
  }
  return '—'
}

// Tooltip content is built as real DOM nodes (never innerHTML) — series names come
// from user-editable GPU/model labels and must go through textContent, not string
// interpolation, per the dataviz skill's untrusted-label rule.
function tooltipTemplate(d: Record<string, number | null>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'space-y-1'

  const time = document.createElement('div')
  time.className = 'text-xs text-muted'
  time.textContent = new Date(d.t as number).toLocaleTimeString()
  wrap.appendChild(time)

  for (const [i, k] of pivoted.value.keys.entries()) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5 text-xs'

    const swatch = document.createElement('span')
    swatch.style.cssText = `display:inline-block;width:10px;height:2px;border-radius:1px;background:${seriesColor(i)}`
    row.appendChild(swatch)

    const value = document.createElement('span')
    value.className = 'font-medium text-highlighted'
    value.textContent = d[k] == null ? '—' : fmt(d[k] as number)
    row.appendChild(value)

    const name = document.createElement('span')
    name.className = 'text-muted'
    name.textContent = k
    row.appendChild(name)

    wrap.appendChild(row)
  }
  return wrap
}
</script>

<template>
  <UCard :ui="{ body: 'p-3 sm:p-4' }">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-sm font-medium text-highlighted">{{ title }}</span>
      <UBadge v-if="error" color="error" variant="subtle" size="sm">source down</UBadge>
    </div>
    <USkeleton v-if="isPending" class="h-48" />
    <div v-else-if="!pivoted.rows.length" class="flex h-48 items-center justify-center text-sm text-muted">no data in range</div>
    <div v-else :style="chromeVars">
      <VisXYContainer :data="pivoted.rows" :height="192" :aria-label="title">
        <VisLine :x="x" :y="yAccessors" :color="lineColors" curve-type="linear" />
        <VisAxis
          type="x" :x="x" :num-ticks="5"
          :tick-format="(t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })"
        />
        <VisAxis type="y" :tick-format="fmt" :num-ticks="4" />
        <VisCrosshair :color="lineColors" :circle-radius="4" :template="tooltipTemplate" />
        <VisTooltip />
      </VisXYContainer>
    </div>
    <div v-if="pivoted.keys.length > 1" class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      <span v-for="(k, i) in pivoted.keys" :key="k" class="inline-flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-3 rounded-full" :style="{ background: seriesColor(i) }" />
        {{ k }}: {{ latest(k) }}
      </span>
    </div>
  </UCard>
</template>
