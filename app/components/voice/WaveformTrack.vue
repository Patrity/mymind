<!-- app/components/voice/WaveformTrack.vue -->
<!-- A small amplitude track: sound levels over time, the duration, and where playback is.
     Used by both studio panes — the read-aloud render and the reference clip — because
     "what does this audio look like" is the same question in both places.

     Drawing is deliberately dumb: every decision about WHAT the bars mean lives in
     app/lib/voice/peaks.ts, where it can be tested. This file owns pixels only. -->
<script setup lang="ts">
import { resamplePeaks, normalizePeaks, formatDuration } from '~/lib/voice/peaks'

const props = withDefaults(defineProps<{
  /** The raw envelope. Resampled to whatever number of bars fits the current width. */
  peaks: number[]
  durationMs: number | null
  /** 0..1. Bars behind the playhead are drawn in the accent colour. */
  progress?: number
  /** Drawn in place of the duration while the audio is still arriving. */
  pending?: boolean
}>(), { progress: 0, pending: false })

const canvas = ref<HTMLCanvasElement | null>(null)
/** Bar + gap, in CSS pixels. Wide enough to read as a level meter rather than a smear. */
const BAR = 3

// Colours come from the theme rather than hex literals, so the track follows the palette
// (and dark mode) without this component knowing anything about either.
function cssColor(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

function draw() {
  const cv = canvas.value
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.round(cv.clientWidth * dpr)
  const h = Math.round(cv.clientHeight * dpr)
  if (!w || !h) return
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
  ctx.clearRect(0, 0, w, h)

  const buckets = Math.max(1, Math.floor(cv.clientWidth / BAR))
  const bars = normalizePeaks(resamplePeaks(props.peaks, buckets))
  const played = cssColor(cv, '--ui-primary', '#6366f1')
  const rest = cssColor(cv, '--ui-text-muted', '#9ca3af')

  const bw = w / buckets
  const mid = h / 2
  const playedTo = Math.max(0, Math.min(1, props.progress)) * buckets
  for (let i = 0; i < buckets; i++) {
    // Always at least one device pixel: a silent stretch should read as a flat line through
    // the middle, not as a gap that looks like missing data.
    const bh = Math.max(dpr, (bars[i] ?? 0) * (h - dpr))
    ctx.fillStyle = i < playedTo ? played : rest
    ctx.globalAlpha = i < playedTo ? 0.95 : 0.4
    ctx.fillRect(i * bw + bw * 0.15, mid - bh / 2, Math.max(dpr, bw * 0.7), bh)
  }
  ctx.globalAlpha = 1
}

let observer: ResizeObserver | null = null
onMounted(() => {
  draw()
  // The panes are resizable, so the bar count is not fixed at mount.
  observer = new ResizeObserver(() => draw())
  if (canvas.value) observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => [props.peaks, props.progress, props.durationMs], () => draw(), { deep: true })
</script>

<template>
  <div class="flex items-center gap-3">
    <canvas
      ref="canvas"
      class="block h-10 min-w-0 flex-1 rounded bg-elevated/40"
    />
    <span class="shrink-0 font-mono text-xs tabular-nums text-muted">
      <template v-if="pending">
        <UIcon
          name="i-lucide-loader-2"
          class="inline size-3 animate-spin"
        />
      </template>
      <template v-else>{{ formatDuration(durationMs) }}</template>
    </span>
  </div>
</template>
