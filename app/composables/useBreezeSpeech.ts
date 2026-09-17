// app/composables/useBreezeSpeech.ts
// Studio playback. Same PCM-on-the-AudioContext-clock approach as useVoice, but over
// plain fetch rather than the agent socket — an audition must not ride the
// conversation's channel.
import { errorFromResponseBody } from '~/lib/voice/studio'
import { createAudioGate, isRunawayRender, type AudioContextFactory } from '~/lib/voice/audio-context'
import { createPeakAccumulator } from '~/lib/voice/peaks'
import type { SpeakOverrides } from '~~/shared/types/voice-presets'

/** The rig is 24 kHz and says so on /health. We build the context at that rate BEFORE the
 *  request so the user gesture is still live; a response that disagrees rebuilds (rare). */
const EXPECTED_SAMPLE_RATE = 24000

/** How much audio we keep in memory so it can be replayed without going back to the rig.
 *  Three minutes at 24 kHz mono float32 is ~17 MB — generous for a read-aloud, and bounded,
 *  which matters because the alternative is a tab that grows without limit across a session.
 *  Past it the envelope still builds (it is ~1/1024th the size); only Replay is withdrawn. */
const RETAIN_MAX_SAMPLES = 24000 * 180

export interface SpeakOptions {
  /** Ad-hoc parameter overrides — lets the studio render exactly what is in the form,
   *  without saving first. Merged server-side; never persisted. */
  overrides?: SpeakOverrides
  /** 'quality' sends the text in one call (continuous prosody); 'realtime' segments it. */
  mode?: 'quality' | 'realtime'
}

export function useBreezeSpeech(factory?: AudioContextFactory) {
  const speaking = ref(false)
  const ttfaMs = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** Raw PCM bytes that actually arrived on the last render.
   *
   *  This is the ONLY evidence of a prompt-ceiling overrun on the streaming path: the rig
   *  answers 200 OK and then dies mid-body, so there is no status and no message. `ttfaMs`
   *  alone is not enough — it detects a stream that delivered NOTHING, but the commoner
   *  shape is a stream that delivers a frame or two and then stops, which sets `ttfaMs`
   *  and would otherwise pass silently. */
  const audioBytes = ref(0)
  /** From the `x-sample-rate` header — needed to turn `audioBytes` into a duration. */
  const sampleRate = ref(24000)
  /** True when the last render ended because `stop()` was called, rather than because it
   *  failed or finished. A user cancel must not be reported as a truncation. */
  const cancelled = ref(false)
  /** True when the render produced far more audio than its text accounts for — the model
   *  ran away to the rig's output cap. Unlike a truncation this returns a COMPLETE body,
   *  so no byte count can see it; only the chars-per-second rate gives it away. */
  const runaway = ref(false)
  /** The amplitude envelope of the last render — what the waveform draws. Built while the
   *  audio streams, so the track fills in rather than appearing at the end. */
  const peaks = ref<number[]>([])
  /** 0..1 through whatever is currently audible. Driven by the AudioContext clock, not a
   *  timer: the clock is what the audio is actually scheduled against. */
  const progress = ref(0)
  /** False when the render was too long to keep, so the UI can hide Replay rather than
   *  offer a button that would silently do nothing. */
  const replayable = ref(false)
  const gate = createAudioGate(factory)
  let playhead = 0
  let abort: AbortController | null = null
  /** Decoded samples of the last render, kept for Replay. Null once a render outgrows
   *  RETAIN_MAX_SAMPLES, or before the first one. */
  let retained: Float32Array[] | null = null
  let retainedLength = 0
  /** The window playback occupies on the context clock, for progress. During a live render
   *  `playEnd` grows as chunks are scheduled. */
  let playStart = 0
  let playEnd = 0
  let raf = 0
  /** Buffers already handed to the context. Closing the context used to stop these for
   *  free; now that the context is reused across renders, stop() has to stop them itself. */
  let sources: AudioBufferSourceNode[] = []

  // The `<ArrayBuffer>` annotation is not decoration: `Float32Array` alone widens to
  // `Float32Array<ArrayBufferLike>`, which copyToChannel rejects (it will not accept a
  // view that might be backed by a SharedArrayBuffer). Same annotation as useVoice's
  // decodePcm, for the same reason.
  function decodePcm(bytes: Uint8Array): Float32Array<ArrayBuffer> {
    const n = bytes.byteLength >> 1
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }

  /** Follows the context clock while anything is audible. Stops itself when playback ends,
   *  so an idle pane costs nothing. */
  function trackProgress() {
    cancelAnimationFrame(raf)
    const step = () => {
      const audio = gate.current()
      const span = playEnd - playStart
      if (audio && span > 0) {
        progress.value = Math.max(0, Math.min(1, (audio.currentTime - playStart) / span))
      }
      // `speaking` as well as `isPlaying`: at the top of a live render nothing is scheduled
      // yet, so isPlaying() is briefly false — and stopping the loop there would freeze the
      // playhead for the whole render.
      if (speaking.value || isPlaying()) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  function schedule(samples: Float32Array<ArrayBuffer>, sampleRate: number) {
    const audio = gate.current()
    if (!audio) return
    const buf = audio.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples, 0)
    const src = audio.createBufferSource()
    src.buffer = buf
    src.connect(audio.destination)
    playhead = Math.max(playhead, audio.currentTime + 0.02)
    src.start(playhead)
    playhead += buf.duration
    playEnd = playhead
    sources.push(src)
    src.onended = () => { sources = sources.filter(s => s !== src) }
  }

  /** Keep the samples if they still fit. Dropping the whole buffer rather than truncating it
   *  is deliberate: half a render replayed as if it were the whole thing is worse than no
   *  Replay button at all. */
  function retain(samples: Float32Array<ArrayBuffer>) {
    if (!retained) return
    retainedLength += samples.length
    if (retainedLength > RETAIN_MAX_SAMPLES) { retained = null; return }
    retained.push(samples)
  }

  async function speak(text: string, presetId: string, opts: SpeakOptions = {}) {
    stop()
    // ── Everything before the first `await` runs inside the click's user activation. ──
    // The AudioContext MUST be created here. Creating it after the fetch (which is what
    // this composable used to do) spends the gesture first, so Chrome hands back a
    // suspended context that never starts: silent playback, no error, no console output,
    // and it "works sometimes" only because an origin accrues sticky activation.
    const audio = gate.ensure(EXPECTED_SAMPLE_RATE)
    speaking.value = true
    error.value = null
    ttfaMs.value = null
    audioBytes.value = 0
    runaway.value = false
    peaks.value = []
    progress.value = 0
    replayable.value = false
    retained = []
    retainedLength = 0
    // Reset AFTER stop(), which aborts any previous render and would otherwise set this.
    cancelled.value = false
    abort = new AbortController()
    const started = performance.now()
    try {
      // Settles the resume kicked off synchronously above; the activation is already spent
      // on it, so awaiting here is safe.
      await gate.resume()
      if (audio && audio.state !== 'running') {
        throw new Error('The browser is blocking audio playback. Click the page, then press Speak again.')
      }
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, presetId, overrides: opts.overrides, mode: opts.mode }),
        signal: abort.signal
      })
      // Parsed, not raw: an h3 error body is a JSON envelope, and the pre-flight's 400
      // sentence is one field inside it.
      if (!res.ok || !res.body) {
        throw new Error(errorFromResponseBody(await res.text().catch(() => ''), res.statusText))
      }
      const rate = Number(res.headers.get('x-sample-rate')) || EXPECTED_SAMPLE_RATE
      sampleRate.value = rate
      // Normally a no-op: the context was already built at this rate above. Only a rig that
      // changed sample rate rebuilds here, and by then the origin has activation to spare.
      const playCtx = rate === EXPECTED_SAMPLE_RATE ? audio : gate.ensure(rate)
      if (!playCtx) throw new Error('Audio playback is not available in this browser.')
      playhead = playCtx.currentTime
      playStart = playhead
      playEnd = playhead
      trackProgress()

      const reader = res.body.getReader()
      const envelope = createPeakAccumulator()
      // The envelope is published on a timer rather than per chunk: a chunk can arrive every
      // few milliseconds, and each publish copies the array and redraws the canvas.
      let lastPublish = 0
      let carry = new Uint8Array(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        if (ttfaMs.value === null) ttfaMs.value = Math.round(performance.now() - started)
        audioBytes.value += value.length
        let bytes: Uint8Array
        if (carry.length) {
          bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry, 0); bytes.set(value, carry.length)
        } else bytes = value
        const usable = bytes.byteLength - (bytes.byteLength % 2)
        carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable)
        if (usable > 0) {
          const samples = decodePcm(bytes.subarray(0, usable))
          schedule(samples, rate)
          envelope.push(samples)
          retain(samples)
          const now = performance.now()
          if (now - lastPublish > 100) {
            lastPublish = now
            peaks.value = [...envelope.peaks()]
          }
        }
      }
      envelope.flush()
      peaks.value = [...envelope.peaks()]
    } catch (e: unknown) {
      // An abort is stop() doing its job, not a failure — but the caller still needs to
      // tell it apart from a render that ended on its own, or a cancel reads as an
      // overrun (no error, no audio).
      if ((e as Error).name === 'AbortError') cancelled.value = true
      else error.value = (e as Error).message
    } finally {
      speaking.value = false
      abort = null
      // A complete body can still be a failure: past ~1000 characters the model rambles to
      // the rig's output cap and returns every byte it promised. Rate is the only tell.
      if (!cancelled.value && !error.value) {
        runaway.value = isRunawayRender(text.length, audioBytes.value / 2 / sampleRate.value)
      }
      // A cancelled render is only half the audio the text asked for, so replaying it would
      // present a truncated take as the finished one.
      replayable.value = !cancelled.value && !error.value && !!retained && retainedLength > 0
    }
  }

  /**
   * Play the last render again without touching the rig.
   *
   * The rig serves ONE request at a time and a read-aloud can take ten seconds, so
   * re-rendering to hear the same words again is the most expensive way to answer the
   * cheapest question. The samples are already decoded; this just schedules them.
   *
   * Must be called from a click, like speak(): `gate.ensure` has to run inside the user
   * activation or Chrome hands back a suspended context (the bug this file was fixed for).
   */
  function replay() {
    if (!retained || !retainedLength) return
    stop()
    const audio = gate.ensure(sampleRate.value)
    if (!audio) return
    cancelled.value = false
    error.value = null
    // One buffer rather than re-scheduling each chunk: the chunk boundaries were an artefact
    // of how the response arrived, and every join is a potential discontinuity.
    const buf = audio.createBuffer(1, retainedLength, sampleRate.value)
    const channel = buf.getChannelData(0)
    let at = 0
    for (const chunk of retained) { channel.set(chunk, at); at += chunk.length }
    const src = audio.createBufferSource()
    src.buffer = buf
    src.connect(audio.destination)
    playStart = audio.currentTime + 0.02
    playhead = playStart
    playEnd = playStart + buf.duration
    src.start(playStart)
    sources.push(src)
    src.onended = () => { sources = sources.filter(s => s !== src) }
    void gate.resume()
    trackProgress()
  }

  /** Stop playback. Deliberately does NOT close the AudioContext: closing it would force the
   *  next render to build one outside a user gesture, which is the bug this file was fixed
   *  for. The context is released only on unmount. */
  function stop() {
    abort?.abort()
    cancelAnimationFrame(raf)
    for (const s of sources) {
      try { s.stop() } catch { /* already ended */ }
      try { s.disconnect() } catch { /* already disconnected */ }
    }
    sources = []
    playhead = 0
    // NOT reset: `progress` keeps whatever fraction actually played, so the waveform still
    // shows where a cancelled render stopped rather than snapping back to the start.
    playStart = 0
    playEnd = 0
    speaking.value = false
  }

  /** True while audio is still audible — buffers are scheduled ahead on the context clock,
   *  so the body finishing does not mean playback has. Lets the UI keep Stop reachable. */
  function isPlaying(): boolean {
    const audio = gate.current()
    return sources.length > 0 || (!!audio && playhead > audio.currentTime + 0.02)
  }

  onBeforeUnmount(() => { stop(); gate.release(); retained = null })
  return {
    speak, stop, replay, isPlaying,
    speaking, ttfaMs, audioBytes, sampleRate, cancelled, runaway, error,
    peaks, progress, replayable
  }
}
