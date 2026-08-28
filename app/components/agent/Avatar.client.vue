<!-- app/components/agent/Avatar.client.vue -->
<script setup lang="ts">
import { createParticleHead } from '../../lib/avatar/particle-head'
import { HeadBufferError } from '../../lib/avatar/head-buffer'
import type { Avatar } from '../../lib/avatar/types'
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
let cancelled = false
let raf = 0
let cleanup: (() => void) | null = null

/** The Avatar interface carries a single state, so the "disconnected" visual is folded
 *  in here the same way the choreographer derives it: not connected and not mid-connect. */
const vizState = computed(() =>
  props.connected || props.state === 'connecting' ? props.state : 'disconnected'
)

function fallback(reason: string, err: unknown) {
  cleanup?.()
  webglOk.value = false
  // A head that has not been baked yet is an expected deployment state, not a fault —
  // the page must still work, so it is a warning, never an unhandled error.
  if (err instanceof HeadBufferError) console.warn(`[avatar] ${reason} — CSS fallback:`, err.message)
  else console.error(`[avatar] ${reason} — CSS fallback`, err)
}

async function boot(el: HTMLDivElement) {
  let head: Avatar
  try {
    head = await createParticleHead(el, {
      onFatal: err => fallback('renderer stopped', err)
    })
  } catch (err) {
    fallback('could not start', err)
    return
  }
  if (cancelled) { head.dispose(); return }

  head.setState(vizState.value)
  const stopState = watch(vizState, s => head.setState(s), { immediate: true })
  const offEvents = props.onVizEvent(e => head.pushEvent(e))

  // useVoice creates its analyser nodes lazily (on connect / first mic enable) and the
  // Avatar interface is push-only, so poll for an identity change instead of widening
  // the interface with a getter. Two reference compares a quarter-second costs nothing.
  let lastMic: AnalyserNode | null = null
  let lastOut: AnalyserNode | null = null
  const syncAnalysers = () => {
    const m = props.micAnalyser()
    const o = props.outAnalyser()
    if (m === lastMic && o === lastOut) return
    lastMic = m; lastOut = o
    head.setAnalysers(m, o)
  }
  syncAnalysers()
  const poll = window.setInterval(syncAnalysers, 250)

  const ro = new ResizeObserver(() => head.resize(el.clientWidth, el.clientHeight))
  ro.observe(el)

  cleanup = () => {
    stopState()
    offEvents()
    window.clearInterval(poll)
    ro.disconnect()
    head.dispose()
    cleanup = null
  }
}

onMounted(() => {
  // The template ref can be null on the first tick under the client-component wrapper;
  // poll a few frames rather than throwing on `host.value!`.
  let tries = 0
  const wait = () => {
    if (cancelled) return
    const el = host.value
    if (el) {
      if (!document.createElement('canvas').getContext('webgl2')) { webglOk.value = false; return }
      void boot(el)
      return
    }
    if (tries++ < 120) raf = requestAnimationFrame(wait)
    else { console.warn('[avatar] host element never appeared — showing fallback'); webglOk.value = false }
  }
  wait()
})

onUnmounted(() => {
  cancelled = true
  cancelAnimationFrame(raf)
  cleanup?.()
})
</script>

<template>
  <div
    ref="host"
    class="relative size-full min-h-[320px]"
  >
    <!-- No-WebGL / no-mesh fallback: a quiet pulse so the page still reads as alive -->
    <div
      v-if="!webglOk"
      class="absolute inset-0 flex items-center justify-center"
    >
      <div class="size-24 animate-pulse rounded-full bg-primary/30" />
    </div>
  </div>
</template>
