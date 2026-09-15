// app/composables/useBreezeSpeech.ts
// Studio playback. Same PCM-on-the-AudioContext-clock approach as useVoice, but over
// plain fetch rather than the agent socket — an audition must not ride the
// conversation's channel.
export function useBreezeSpeech() {
  const speaking = ref(false)
  const ttfaMs = ref<number | null>(null)
  const error = ref<string | null>(null)
  const ctx = shallowRef<AudioContext | null>(null)
  let playhead = 0
  let abort: AbortController | null = null

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

  function schedule(samples: Float32Array<ArrayBuffer>, sampleRate: number) {
    const audio = ctx.value!
    const buf = audio.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples, 0)
    const src = audio.createBufferSource()
    src.buffer = buf
    src.connect(audio.destination)
    playhead = Math.max(playhead, audio.currentTime + 0.02)
    src.start(playhead)
    playhead += buf.duration
  }

  async function speak(text: string, presetId: string) {
    stop()
    speaking.value = true
    error.value = null
    ttfaMs.value = null
    abort = new AbortController()
    const started = performance.now()
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, presetId }),
        signal: abort.signal
      })
      if (!res.ok || !res.body) throw new Error(await res.text().catch(() => res.statusText))
      const sampleRate = Number(res.headers.get('x-sample-rate')) || 24000
      ctx.value = new AudioContext({ sampleRate })
      playhead = ctx.value.currentTime

      const reader = res.body.getReader()
      let carry = new Uint8Array(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        if (ttfaMs.value === null) ttfaMs.value = Math.round(performance.now() - started)
        let bytes: Uint8Array
        if (carry.length) {
          bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry, 0); bytes.set(value, carry.length)
        } else bytes = value
        const usable = bytes.byteLength - (bytes.byteLength % 2)
        carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable)
        if (usable > 0) schedule(decodePcm(bytes.subarray(0, usable)), sampleRate)
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') error.value = (e as Error).message
    } finally {
      speaking.value = false
      abort = null
    }
  }

  function stop() {
    abort?.abort()
    ctx.value?.close()
    ctx.value = null
    playhead = 0
    speaking.value = false
  }

  onBeforeUnmount(stop)
  return { speak, stop, speaking, ttfaMs, error }
}
