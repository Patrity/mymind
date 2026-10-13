<script setup lang="ts">
/** A suite's non-holdout pass-rate trend (finished runs, oldest → newest), 0–100%. */
import { sparkPoints } from '~/lib/evals/display'

const props = withDefaults(defineProps<{ values: Array<number | null>, width?: number, height?: number }>(), { width: 104, height: 24 })
const points = computed(() => sparkPoints(props.values, props.width, props.height))
const last = computed(() => {
  const pts = points.value.split(' ').filter(Boolean)
  const [x, y] = (pts.at(-1) ?? '').split(',').map(Number)
  return pts.length ? { x: x!, y: y! } : null
})
const label = computed(() => `Pass rate over the last ${props.values.length} runs: ${props.values.map(v => (v === null ? '—' : `${Math.round(v * 100)}%`)).join(', ')}`)
</script>

<template>
  <svg
    v-if="values.length"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    :aria-label="label"
    class="text-primary"
    data-testid="eval-sparkline"
  >
    <title>{{ label }}</title>
    <line
      x1="0"
      :x2="width"
      :y1="height - 2"
      :y2="height - 2"
      class="stroke-(--ui-border)"
      stroke-width="1"
    />
    <polyline
      :points="points"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <circle
      v-if="last"
      :cx="last.x"
      :cy="last.y"
      r="2.5"
      fill="currentColor"
    />
  </svg>
  <span
    v-else
    class="text-xs text-dimmed"
  >no finished runs</span>
</template>
