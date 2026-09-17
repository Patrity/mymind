// app/composables/useClipPlayer.ts
// Play a reference clip and draw its envelope.
//
// Separate from useBreezeSpeech because the two solve different problems: that one plays a
// STREAM as it arrives from the rig, this one plays a finished WAV that already exists —
// either in blob storage (a saved preset) or in the browser (a clip just uploaded or
// recorded, before Save). Sharing the audio gate matters more than sharing the code: the
// autoplay rule that makes a context born after an `await` silent applies here too.
import { createAudioGate, type AudioContextFactory } from '~/lib/voice/audio-context'
import { computePeaks } from '~/lib/voice/peaks'

/** The studio's working rate. A reference clip recorded at 44.1 kHz is resampled by
 *  decodeAudioData, which is what the rig effectively does with it anyway — so this preview
 *  is closer to what the model hears than the original file would be. */
const STUDIO_RATE = 24000

export function useClipPlayer(factory?: AudioContextFactory) {
  const peaks = ref<number[]>([])
  const durationMs = ref<number | null>(null)
  const progress = ref(0)
  const playing = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const gate = createAudioGate(factory)
  let buffer: AudioBuffer | null = null
  let source: AudioBufferSourceNode | null = null
  let playStart = 0
  let raf = 0

  function stop() {
    cancelAnimationFrame(raf)
    if (source) {
      try { source.stop() } catch { /* already ended */ }
      try { source.disconnect() } catch { /* already disconnected */ }
      source = null
    }
    playing.value = false
  }

  /** Forget the clip entirely — used when the reference is removed or the preset changes,
   *  so a stale waveform never sits under a voice it does not belong to. */
  function clear() {
    stop()
    buffer = null
    peaks.value = []
    durationMs.value = null
    progress.value = 0
    error.value = null
  }

  /**
   * Decode a clip and build its envelope. `src` is a URL for a saved clip or a Blob for one
   * that only exists in the browser so far — an upload or a recording is decodable before it
   * has ever been saved, and making the user save first to see the waveform would be the
   * same "save before you can hear it" friction the Speak button was fixed for.
   *
   * Does NOT need a user gesture: decoding works on a suspended context. Only `play` does.
   */
  async function load(src: string | Blob) {
    clear()
    loading.value = true
    try {
      const bytes = typeof src === 'string'
        ? await fetch(src).then(r => {
          if (!r.ok) throw new Error(r.status === 404 ? 'The reference clip is no longer in storage.' : `Could not load the clip (${r.status}).`)
          return r.arrayBuffer()
        })
        : await src.arrayBuffer()
      const audio = gate.ensure(STUDIO_RATE)
      if (!audio) throw new Error('Audio playback is not available in this browser.')
      buffer = await audio.decodeAudioData(bytes)
      peaks.value = computePeaks(buffer.getChannelData(0))
      durationMs.value = Math.round(buffer.duration * 1000)
    } catch (e) {
      error.value = (e as Error).message
      buffer = null
    } finally {
      loading.value = false
    }
  }

  /** Call from a click: `ensure` has to run inside the user activation. */
  function play() {
    if (!buffer) return
    stop()
    const audio = gate.ensure(STUDIO_RATE)
    if (!audio) return
    const src = audio.createBufferSource()
    src.buffer = buffer
    src.connect(audio.destination)
    playStart = audio.currentTime + 0.02
    src.start(playStart)
    source = src
    playing.value = true
    src.onended = () => {
      if (source === src) { source = null; playing.value = false; progress.value = 1 }
    }
    void gate.resume()

    const span = buffer.duration
    const step = () => {
      const ctx = gate.current()
      if (!ctx || !playing.value) return
      progress.value = Math.max(0, Math.min(1, (ctx.currentTime - playStart) / span))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  function toggle() {
    if (playing.value) stop()
    else play()
  }

  onBeforeUnmount(() => { stop(); gate.release(); buffer = null })

  return { load, play, stop, toggle, clear, peaks, durationMs, progress, playing, loading, error }
}
