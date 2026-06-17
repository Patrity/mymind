// app/composables/useVoice.ts
import { createEmitter } from '../lib/viz/emitter'
import { mapServerMessage } from '../lib/voice/messages'
import type { VizEvent } from '../lib/viz/types'

export type VoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool' | 'typing'
export interface TranscriptEntry { role: 'user' | 'assistant'; text: string }

// Capture/barge-in/playback knobs are user-tunable and cookie-persisted —
// see useVoiceSettings. NOTE: vad-web 0.0.30 uses time-based options
// (minSpeechMs, redemptionMs) rather than frame-based ones.

export function useVoice() {
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)
  /** Live Silero speech probability (0..1) — feeds the settings tuning meter. */
  const speechProb = ref(0)
  const { settings } = useVoiceSettings()

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
      node.playbackRate.value = settings.value.playbackRate
      node.connect(outAnalyser)
      const at = Math.max(audioCtx.currentTime, playCursor)
      node.start(at)
      playCursor = at + buf.duration / settings.value.playbackRate
      sources.push(node)
      node.onended = () => {
        sources = sources.filter(s => s !== node)
        // Playback fully drained → reflect idle (the server already signalled done).
        if (!isPlaying() && state.value === 'speaking') state.value = 'idle'
      }
    } catch { /* skip undecodable */ }
  }

  // Bumped on every stop(): async startup steps (VAD model/wasm fetches can take
  // seconds over WAN) bail out when their session is stale instead of constructing
  // audio nodes on a closed AudioContext ("No execution context available").
  let session = 0

  /**
   * Connect: build AudioContext (for playback) + open the WS. Does NOT start the
   * VAD or request mic permission. Safe to call from a text-first UI without ever
   * prompting for mic access.
   */
  async function connect() {
    if (ws || state.value === 'connecting') return
    error.value = null
    state.value = 'connecting'
    const mySession = ++session
    try {
      await connectInner(mySession)
    } catch (err) {
      if (mySession !== session) return // torn down mid-start — stop() already cleaned up
      // WS setup failure would otherwise strand the UI in 'connecting'.
      error.value = err instanceof Error ? err.message : 'Voice startup failed'
      events.emit({ type: 'error' })
      stop()
    }
  }

  async function connectInner(mySession: number) {
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
      // Apply the persisted voice choice (and re-apply on reconnect).
      const v = desiredVoice ?? { provider: settings.value.provider, voice: settings.value.voice }
      ws!.send(JSON.stringify({ type: 'voice', ...v }))
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
    // connectInner does NOT call startVad — call enableMic() separately for mic input.
    if (mySession !== session) return // stop() landed while setting up
  }

  /**
   * Enable microphone input: start the VAD + getUserMedia. Requires the WS to be
   * connected first (`connected.value === true`). No-op if VAD is already running.
   */
  async function enableMic() {
    if (!connected.value || vad) return
    const mySession = session
    try {
      await startVad(mySession)
    } catch (err) {
      if (mySession !== session) return
      error.value = err instanceof Error ? err.message : 'Mic startup failed'
      events.emit({ type: 'error' })
    }
  }

  /**
   * Disable microphone input: destroy the VAD and release the mic stream. The WS
   * and AudioContext remain live — audio playback continues unaffected.
   */
  async function disableMic() {
    if (!vad) return
    const current = session
    await vad.destroy()
    if (current !== session) return // stop() raced us
    vad = null
    vizStream?.getTracks().forEach(t => t.stop())
    vizStream = null
    speechProb.value = 0
  }

  async function startVad(mySession: number) {
    // Dynamic import keeps onnxruntime-web out of the SSR bundle (cached after first call)
    const { MicVAD } = await import('@ricky0123/vad-web')
    if (mySession !== session || !audioCtx) return // stopped while the module loaded
    const v = await MicVAD.new({
      audioContext: audioCtx!,
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
      positiveSpeechThreshold: settings.value.positiveSpeechThreshold,
      negativeSpeechThreshold: negativeSpeechThreshold(settings.value.positiveSpeechThreshold),
      minSpeechMs: settings.value.minSpeechMs,
      redemptionMs: settings.value.redemptionMs,
      // Live speech probability for the settings tuning meter (same unit as the threshold).
      onFrameProcessed: (probs: { isSpeech: number }) => { speechProb.value = probs.isSpeech },
      onSpeechStart: () => {
        if (settings.value.bargeInEnabled && isPlaying()) {
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
    if (mySession !== session) { v.destroy(); return } // stopped during the (slow) model fetch
    vad = v
    v.start()
  }

  /**
   * Hot-apply VAD settings: vad-web bakes thresholds in at construction, so a
   * live session restarts just the VAD (mic stream re-acquired, WS untouched).
   * No-op when not connected — the next start() reads the current settings.
   */
  async function applyVadSettings() {
    if (!vad || !audioCtx) return
    const mySession = session
    await vad.destroy()
    if (mySession !== session) return // stop() landed mid-restart
    vad = null
    vizStream?.getTracks().forEach(t => t.stop())
    vizStream = null
    speechProb.value = 0
    await startVad(mySession)
  }

  function stop() {
    session++ // invalidate any in-flight startup/restart
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
    speechProb.value = 0
    connected.value = false
  }

  /**
   * Backwards-compatible start(): equivalent to connect() (mic OFF by default —
   * text-first UX). Call enableMic() afterwards for voice input.
   */
  async function start() {
    await connect()
  }

  onUnmounted(stop)

  return {
    state,
    connected,
    transcript,
    error,
    /** Connect the WS + AudioContext (no mic). Text-first entry point. */
    connect,
    /** Start VAD + request mic permission. Requires connected === true. */
    enableMic,
    /** Stop VAD + release mic stream. WS + playback remain live. */
    disableMic,
    /** Backwards-compatible alias for connect(). Mic stays OFF. */
    start,
    stop,
    setVoice: (provider: string, voice: string) => {
      desiredVoice = { provider, voice }
      settings.value = { ...settings.value, provider, voice } // persist the pick
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice', provider, voice }))
    },
    speechProb,
    applyVadSettings,
    /**
     * Send a typed turn through the voice loop. Pass speak=true to have the
     * agent answer aloud; speak=false (default) for text-only response.
     * Returns false when the WS isn't open (caller should fall back to the
     * text-only chat endpoint).
     */
    sendText: (text: string, speak = false): boolean => {
      const t = text.trim()
      if (!t || ws?.readyState !== WebSocket.OPEN) return false
      if (isPlaying()) { stopPlayback(); events.emit({ type: 'bargein' }) } // typed barge-in
      ws.send(JSON.stringify({ type: 'text', text: t, speak }))
      return true
    },
    /**
     * Resume a previous conversation by ID. The page is responsible for
     * hydrating the transcript from the HTTP fetch (see T8).
     */
    loadConversation: (id: string) => {
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'load', conversationId: id }))
    },
    /**
     * Start a fresh conversation: signals the server to reset context and
     * clears the local transcript.
     */
    newConversation: () => {
      transcript.value = []
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'new' }))
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
