// app/composables/useVoice.ts
import { createEmitter } from '../lib/viz/emitter'
import { mapServerMessage } from '../lib/voice/messages'
import type { VizEvent } from '../lib/viz/types'

export type VoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool'
export interface TranscriptEntry { role: 'user' | 'assistant'; text: string }

// Client mirror of the tunable knobs that affect capture/barge-in.
// NOTE: vad-web 0.0.30 uses time-based options (minSpeechMs, redemptionMs)
// rather than frame-based (minSpeechFrames, redemptionFrames).
const TUNING = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 100,      // ~3 frames @ 30ms/frame ≈ original minSpeechFrames: 3
  redemptionMs: 240,     // ~8 frames @ 30ms/frame ≈ original redemptionFrames: 8
  bargeInEnabled: true,
  playbackRate: 1.1,
}

export function useVoice() {
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)

  const events = createEmitter<VizEvent>()

  let ws: WebSocket | null = null
  // Last voice the user picked. Selecting before connecting (the natural UX) would
  // otherwise be lost — ws is null then, so we remember it and (re)send on open.
  let desiredVoice: { provider: string; voice: string } | null = null
  let vad: { start: () => Promise<void>; destroy: () => Promise<void> } | null = null
  let audioCtx: AudioContext | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null
  let vizStream: MediaStream | null = null
  let playCursor = 0
  let sources: AudioBufferSourceNode[] = []
  // decodeAudioData resolves at different speeds per chunk, so decoding chunks
  // concurrently lets a later chunk schedule ahead of an earlier one (reordered /
  // skipped words). Serialize decode+schedule through a promise chain so chunks
  // play in arrival order. `playEpoch` invalidates queued chunks after a barge-in.
  let decodeChain: Promise<void> = Promise.resolve()
  let playEpoch = 0

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) last.text += (/\S$/.test(last.text) && /^\w/.test(delta) ? ' ' : '') + delta
    else transcript.value.push({ role, text: delta })
  }

  function stopPlayback() {
    playEpoch++ // invalidate any queued/in-flight decodes from the interrupted turn
    decodeChain = Promise.resolve()
    for (const s of sources) {
      try { s.stop() } catch { /* already stopped */ }
      try { s.disconnect() } catch { /* already disconnected */ }
    }
    sources = []
    playCursor = 0
  }

  // True while audio is actually playing or scheduled ahead. The server emits
  // state:'idle' as soon as the agent finishes GENERATING, but the client has by
  // then buffered the sentence WAVs into the future — so barge-in must key off real
  // playback, not the server-driven state.value.
  function isPlaying(): boolean {
    return sources.length > 0 || (!!audioCtx && playCursor > audioCtx.currentTime + 0.02)
  }

  // Enqueue a chunk: decode + schedule run strictly after the previous chunk's,
  // preserving arrival order. Stale chunks (superseded by a barge-in) are dropped.
  function enqueueWav(bytes: ArrayBuffer) {
    const epoch = playEpoch
    decodeChain = decodeChain.then(() => playWav(bytes, epoch))
  }

  async function playWav(bytes: ArrayBuffer, epoch: number) {
    if (!audioCtx || !outAnalyser || epoch !== playEpoch) return
    try {
      const buf = await audioCtx.decodeAudioData(bytes.slice(0))
      if (epoch !== playEpoch) return // barge-in landed while decoding — drop it
      const node = audioCtx.createBufferSource()
      node.buffer = buf
      node.playbackRate.value = TUNING.playbackRate
      node.connect(outAnalyser)
      const at = Math.max(audioCtx.currentTime, playCursor)
      node.start(at)
      playCursor = at + buf.duration / TUNING.playbackRate
      sources.push(node)
      node.onended = () => {
        sources = sources.filter(s => s !== node)
        // Playback fully drained → reflect idle (the server already signalled done).
        if (!isPlaying() && state.value === 'speaking') state.value = 'idle'
      }
    } catch { /* skip undecodable */ }
  }

  async function start() {
    if (ws || state.value === 'connecting') return
    error.value = null
    state.value = 'connecting'
    try {
      await startInner()
    } catch (err) {
      // VAD asset import or mic permission failure would otherwise strand the
      // UI in 'connecting' (or leave a live WS with no mic). Tear down fully.
      error.value = err instanceof Error ? err.message : 'Voice startup failed'
      events.emit({ type: 'error' })
      stop()
    }
  }

  async function startInner() {
    // Dynamic import keeps onnxruntime-web out of the SSR bundle
    const { MicVAD } = await import('@ricky0123/vad-web')

    audioCtx = new AudioContext()
    outAnalyser = audioCtx.createAnalyser()
    outAnalyser.fftSize = 256
    outAnalyser.connect(audioCtx.destination)
    micAnalyser = audioCtx.createAnalyser()
    micAnalyser.fftSize = 256

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/voice/ws`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      connected.value = true
      state.value = 'idle'
      // Apply a voice chosen before the socket existed (and re-apply on reconnect).
      if (desiredVoice) ws!.send(JSON.stringify({ type: 'voice', ...desiredVoice }))
    }
    ws.onclose = () => { connected.value = false; state.value = 'idle'; events.emit({ type: 'disconnected' }) }
    ws.onerror = () => { error.value = 'WebSocket error'; events.emit({ type: 'error' }) }
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        state.value = 'speaking'
        enqueueWav(e.data)
      } else {
        const fx = mapServerMessage(JSON.parse(e.data as string), isPlaying())
        if (fx.delta) pushDelta(fx.delta.role, fx.delta.text)
        if (fx.state) state.value = fx.state
        if (fx.error) error.value = fx.error
        for (const ev of fx.events) events.emit(ev)
      }
    }

    vad = await MicVAD.new({
      audioContext: audioCtx,
      // Serve VAD worklet + ONNX model and onnxruntime-web WASM from our own origin
      // (mapped in nuxt.config nitro.publicAssets). Without these, vad-web defaults to
      // "/" and the assets 404 → the mic captures nothing.
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/ort/',
      getStream: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
        vizStream = stream
        try {
          audioCtx!.createMediaStreamSource(stream).connect(micAnalyser!)
        } catch { /* visualization only — ignore */ }
        return stream
      },
      positiveSpeechThreshold: TUNING.positiveSpeechThreshold,
      negativeSpeechThreshold: TUNING.negativeSpeechThreshold,
      minSpeechMs: TUNING.minSpeechMs,
      redemptionMs: TUNING.redemptionMs,
      onSpeechStart: () => {
        if (TUNING.bargeInEnabled && isPlaying()) {
          stopPlayback()
          ws?.send(JSON.stringify({ type: 'interrupt' }))
          events.emit({ type: 'bargein' })
        }
        state.value = 'listening'
      },
      onSpeechEnd: (audio: Float32Array) => {
        state.value = 'thinking'
        if (ws?.readyState === WebSocket.OPEN) ws.send(floatToWav(audio, 16000))
      },
    })
    vad.start()
  }

  function stop() {
    vad?.destroy()
    stopPlayback()
    ws?.close()
    vizStream?.getTracks().forEach(t => t.stop())
    audioCtx?.close()
    vad = null
    ws = null
    vizStream = null
    audioCtx = null
    state.value = 'idle'
    connected.value = false
  }

  onUnmounted(stop)

  return {
    state,
    connected,
    transcript,
    error,
    start,
    stop,
    setVoice: (provider: string, voice: string) => {
      desiredVoice = { provider, voice }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice', provider, voice }))
    },
    micAnalyser: () => micAnalyser,
    outAnalyser: () => outAnalyser,
    onVizEvent: events.on,
  }
}

// 16-bit PCM WAV from Float32 samples (what Whisper accepts).
function floatToWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, samples.length * 2, true)
  let o = 44
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] ?? 0))
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
    o += 2
  }
  return buf
}
