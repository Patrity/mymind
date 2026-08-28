<!-- app/components/agent/MicBand.vue -->
<!-- "Am I being heard" — replaces the decorative 96-bar ring with two signals
     that answer that question directly:
       1. FFT bars from micAnalyser (fftSize 256 -> 128 bins): amplitude, what
          is actually arriving at the microphone.
       2. A separate probability track driven by speechProb: Silero's per-frame
          speech PROBABILITY, a different unit from amplitude. The VAD threshold
          only makes sense drawn against this track, never against the bars. -->
<script setup lang="ts">
import { PALETTE } from '~/lib/viz/tuning'

const props = defineProps<{
  micAnalyser: AnalyserNode | null
  speechProb: number
  active: boolean
}>()

const { settings } = useVoiceSettings()
const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0

const BARS = 56

// Reuse the existing viz palette rather than inventing new hex values: cyan is
// already what the ring used for live mic pickup during 'listening', the idle
// ring blue is already its resting tone, and amber is already the viz's
// attention/accent color (used for tool pulses) — reused here for the VAD
// threshold marker.
function rgba(c: readonly [number, number, number], a: number): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`
}
const ACTIVE = PALETTE.listening.ring
const IDLE = PALETTE.idle.ring
const THRESHOLD = PALETTE.tool.core

function draw() {
  const cv = canvas.value
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) { raf = requestAnimationFrame(draw); return }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.clientWidth * dpr
  const h = cv.clientHeight * dpr
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }

  ctx.clearRect(0, 0, w, h)

  const trackH = Math.max(3 * dpr, h * 0.12)
  const barsH = h - trackH - 2 * dpr

  // ── FFT bars: what the microphone is actually picking up (amplitude) ──
  const speaking = props.active && props.speechProb >= settings.value.positiveSpeechThreshold
  if (props.micAnalyser) {
    const bins = new Uint8Array(props.micAnalyser.frequencyBinCount)
    props.micAnalyser.getByteFrequencyData(bins)
    const bw = w / BARS
    for (let i = 0; i < BARS; i++) {
      // Log-spaced: voice energy sits low, so a linear map wastes most of the width.
      const t = i / (BARS - 1)
      const bin = Math.min(bins.length - 1, Math.round(Math.pow(t, 2) * (bins.length - 1)))
      const v = (bins[bin] ?? 0) / 255
      const bh = Math.max(1 * dpr, v * barsH)
      ctx.fillStyle = speaking ? rgba(ACTIVE, 0.95) : rgba(IDLE, 0.55)
      ctx.fillRect(i * bw + bw * 0.2, barsH - bh, bw * 0.6, bh)
    }
  }

  // ── Speech-probability track, with the VAD threshold marked. A DIFFERENT unit
  //    from the bars above: this is Silero's per-frame probability, which is what
  //    actually decides whether a turn fires. ──
  const y = h - trackH
  ctx.fillStyle = rgba(IDLE, 0.18)
  ctx.fillRect(0, y, w, trackH)
  ctx.fillStyle = speaking ? rgba(ACTIVE, 0.9) : rgba(IDLE, 0.65)
  ctx.fillRect(0, y, w * Math.min(1, Math.max(0, props.speechProb)), trackH)

  const tx = w * settings.value.positiveSpeechThreshold
  ctx.fillStyle = rgba(THRESHOLD, 0.9)
  ctx.fillRect(tx - dpr, y - 2 * dpr, 2 * dpr, trackH + 4 * dpr)

  raf = requestAnimationFrame(draw)
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="relative h-14 shrink-0 border-t border-default/40 bg-elevated">
    <canvas
      ref="canvas"
      class="block h-full w-full"
    />
    <span
      class="pointer-events-none absolute left-2 top-1 font-mono text-[9px] uppercase tracking-wider"
      :class="active ? 'text-primary/80' : 'text-muted/60'"
    >
      {{ active ? 'listening' : 'mic off' }}
    </span>
  </div>
</template>
