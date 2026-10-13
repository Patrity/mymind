<script setup lang="ts">
/**
 * A suite's run history: non-holdout pass rate and mean score per finished run, oldest → newest.
 * Two series on one 0–100% axis; the tooltip is built from DOM nodes (textContent only) because the
 * model label is configuration text.
 */
import { VisAxis, VisCrosshair, VisLine, VisScatter, VisTooltip, VisXYContainer } from '@unovis/vue'
import type { EvalRunDTO } from '@mymind/core/shared/types/eval'

const props = defineProps<{ runs: EvalRunDTO[] }>()

interface Point { i: number, passRate: number | undefined, mean: number | undefined, run: EvalRunDTO }
const points = computed<Point[]>(() => props.runs.filter(r => r.status === 'done').slice().reverse().map((run, i) => ({
  i,
  passRate: run.summary?.nonHoldout.passRate ?? undefined,
  mean: run.summary?.nonHoldout.meanScore ?? undefined,
  run
})))

// dataviz palette (the same two hues analytics uses first), validated in both modes.
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const colors = computed(() => (isDark.value ? ['#3987e5', '#c98500'] : ['#2a78d6', '#eda100']))
const chromeVars = computed(() => (isDark.value
  ? { '--vis-axis-grid-color': '#2c2c2a', '--vis-axis-tick-label-color': '#898781', '--vis-crosshair-line-stroke-color': '#898781', '--vis-tooltip-background-color': '#1a1a19', '--vis-tooltip-border-color': '#2c2c2a', '--vis-tooltip-text-color': '#ffffff' }
  : { '--vis-axis-grid-color': '#e1e0d9', '--vis-axis-tick-label-color': '#898781', '--vis-crosshair-line-stroke-color': '#898781', '--vis-tooltip-background-color': '#fcfcfb', '--vis-tooltip-border-color': '#e1e0d9', '--vis-tooltip-text-color': '#0b0b0b' }))

const x = (d: Point) => d.i
const ys = [(d: Point) => d.passRate, (d: Point) => d.mean]
const pctTick = (v: number) => `${Math.round(v * 100)}%`
// Ticks only at real runs (at most ~6, evenly spaced), labelled with their start time.
const tickValues = computed(() => {
  const n = points.value.length
  const step = Math.max(1, Math.ceil(n / 6))
  return points.value.filter(p => p.i % step === 0 || p.i === n - 1).map(p => p.i)
})
const xTick = (v: number) => {
  const p = points.value[v]
  return p ? new Date(p.run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

function tooltip(d: Point): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'space-y-0.5 text-xs'
  const line = (text: string, color?: string) => {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5'
    if (color) {
      const sw = document.createElement('span')
      sw.style.cssText = `display:inline-block;width:10px;height:2px;background:${color}`
      row.appendChild(sw)
    }
    const t = document.createElement('span')
    t.textContent = text
    row.appendChild(t)
    wrap.appendChild(row)
  }
  line(new Date(d.run.startedAt).toLocaleString())
  line(`pass rate ${d.passRate === undefined ? '—' : pctTick(d.passRate)}`, colors.value[0])
  line(`mean score ${d.mean === undefined ? '—' : d.mean.toFixed(2)}`, colors.value[1])
  line(`${d.run.modelLabel ?? 'model ?'} · ${d.run.gitSha?.slice(0, 7) ?? 'sha ?'}`)
  return wrap
}
</script>

<template>
  <div data-testid="eval-run-history">
    <div
      v-if="points.length < 2"
      class="flex h-40 items-center justify-center text-sm text-muted"
    >
      {{ points.length ? 'One finished run so far — the chart starts at two.' : 'No finished runs yet.' }}
    </div>
    <div
      v-else
      :style="chromeVars"
    >
      <VisXYContainer
        :data="points"
        :height="180"
        :y-domain="[0, 1]"
        aria-label="Run history: pass rate and mean score per run"
      >
        <VisLine
          :x="x"
          :y="ys"
          :color="colors"
        />
        <VisScatter
          :x="x"
          :y="ys[0]"
          :color="colors[0]"
          :size="6"
        />
        <VisAxis
          type="x"
          :x="x"
          :tick-values="tickValues"
          :tick-format="xTick"
        />
        <VisAxis
          type="y"
          :tick-format="pctTick"
          :num-ticks="5"
        />
        <VisCrosshair
          :color="colors"
          :template="tooltip"
        />
        <VisTooltip />
      </VisXYContainer>
      <div class="mt-1 flex gap-4 text-xs text-muted">
        <span class="inline-flex items-center gap-1.5"><span
          class="inline-block h-0.5 w-3"
          :style="{ background: colors[0] }"
        />pass rate (non-holdout)</span>
        <span class="inline-flex items-center gap-1.5"><span
          class="inline-block h-0.5 w-3"
          :style="{ background: colors[1] }"
        />mean score</span>
      </div>
    </div>
  </div>
</template>
