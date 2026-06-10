<!-- app/components/voice/Reactor.client.vue -->
<script setup lang="ts">
import { createScene, detectTier } from '../../lib/viz/scene'
import { createCore } from '../../lib/viz/core'
import { createRing } from '../../lib/viz/ring'
import { createEffects } from '../../lib/viz/effects'
import { createChoreographer } from '../../lib/viz/choreographer'
import { BAR_COUNT } from '../../lib/viz/types'
import type { VizEvent } from '../../lib/viz/types'
import type { VoiceState } from '../../composables/useVoice'

const props = defineProps<{
  state: VoiceState
  connected: boolean
  micAnalyser: () => AnalyserNode | null
  outAnalyser: () => AnalyserNode | null
  onVizEvent: (cb: (e: VizEvent) => void) => () => void
}>()

const host = ref<HTMLDivElement | null>(null)
const webglOk = ref(true)
let raf = 0
let cancelled = false
let teardown: (() => void) | null = null

function boot(el: HTMLDivElement) {
  let scene: ReturnType<typeof createScene> | undefined
  let core: ReturnType<typeof createCore> | undefined
  let ring: ReturnType<typeof createRing> | undefined
  let fx: ReturnType<typeof createEffects> | undefined
  try {
    const tier = detectTier()
    scene = createScene(el, tier)
    core = createCore(tier.particles)
    ring = createRing()
    fx = createEffects()
    scene.scene.add(core.object, ring.object, fx.object)
  } catch (err) {
    // The visualizer is decorative — never let it take the voice page down.
    console.error('[viz] init failed', err)
    fx?.dispose()
    ring?.dispose()
    core?.dispose()
    scene?.dispose()
    webglOk.value = false
    return
  }

  const choreo = createChoreographer()
  const offEvents = props.onVizEvent(e => choreo.handleEvent(e))

  const micData = new Uint8Array(128) // analyser fftSize 256 → 128 bins
  const outData = new Uint8Array(128)
  const micLevels = new Float32Array(BAR_COUNT)

  // FPS watchdog: sustained sub-27fps average triggers two one-way degrade steps.
  // (Threshold sits below 30 so healthy 30Hz displays never trip it.)
  let degradeStep = 0
  let dtAvg = 1 / 60
  let slowSince = 0
  let frameErrors = 0

  let last = performance.now()
  let t = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    t += dt

    try {
      const mic = props.micAnalyser()
      if (mic) {
        mic.getByteFrequencyData(micData as Uint8Array<ArrayBuffer>)
        for (let i = 0; i < BAR_COUNT; i++) {
          micLevels[i] = (micData[Math.floor(i * micData.length / BAR_COUNT)] ?? 0) / 255
        }
      } else {
        micLevels.fill(0)
      }
      let outLevel = 0
      const out = props.outAnalyser()
      if (out) {
        out.getByteFrequencyData(outData as Uint8Array<ArrayBuffer>)
        let sum = 0
        for (let i = 0; i < outData.length; i++) sum += outData[i] ?? 0
        outLevel = sum / outData.length / 255
      }

      const d = choreo.update({ state: props.state, connected: props.connected, micLevels, outLevel }, dt)
      core!.update(d, t, dt)
      ring!.update(d, t, dt)
      fx!.update(d, t, dt)
      scene!.render()

      dtAvg += (dt - dtAvg) * 0.05 // ~smooth over the last couple seconds of frames
      if (dtAvg > 1 / 27) { if (!slowSince) slowSince = now }
      else slowSince = 0
      if (slowSince && now - slowSince > 3000 && degradeStep < 2) {
        degradeStep++
        if (degradeStep === 1) scene!.degrade()
        else core!.setDrawRange(0.5)
        slowSince = 0
        dtAvg = 1 / 60 // re-measure from a clean slate after each step
      }

      frameErrors = 0
    } catch (err) {
      // A persistent render fault should degrade to the CSS fallback, not spam forever.
      if (++frameErrors >= 10) {
        console.error('[viz] persistent frame failure — falling back', err)
        teardown?.()
        webglOk.value = false
      }
    }
  }
  raf = requestAnimationFrame(frame)

  const ro = new ResizeObserver(() => {
    scene!.setSize(el.clientWidth || 320, el.clientHeight || 320)
  })
  ro.observe(el)

  const onVis = () => {
    cancelAnimationFrame(raf)
    if (!document.hidden && !cancelled) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  // Scroll-zoom: dolly the camera instead of scrolling the page.
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    scene!.zoom(e.deltaY)
  }
  el.addEventListener('wheel', onWheel, { passive: false })

  scene!.onContextLost(() => {
    // GPU reset (driver hiccup, mobile background) — rebuild the whole scene.
    teardown?.()
    if (!cancelled && host.value) boot(host.value)
  })

  teardown = () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    document.removeEventListener('visibilitychange', onVis)
    el.removeEventListener('wheel', onWheel)
    offEvents()
    core!.dispose()
    ring!.dispose()
    fx!.dispose()
    scene!.dispose()
    teardown = null
  }
}

onMounted(() => {
  // The template ref can be null on the first tick under the client-component
  // wrapper; poll a few frames rather than throwing on `host.value!`.
  let tries = 0
  const wait = () => {
    if (cancelled) return
    const el = host.value
    if (el) {
      if (!document.createElement('canvas').getContext('webgl2')) { webglOk.value = false; return }
      boot(el)
      return
    }
    if (tries++ < 120) raf = requestAnimationFrame(wait)
    else { console.warn('[viz] host element never appeared — showing fallback'); webglOk.value = false }
  }
  wait()
})

onUnmounted(() => {
  cancelled = true
  cancelAnimationFrame(raf)
  teardown?.()
})
</script>

<template>
  <div ref="host" class="relative size-full min-h-[320px]">
    <!-- No-WebGL fallback: a quiet pulse so the page still reads as alive -->
    <div v-if="!webglOk" class="absolute inset-0 flex items-center justify-center">
      <div class="size-24 animate-pulse rounded-full bg-primary/30" />
    </div>
  </div>
</template>
