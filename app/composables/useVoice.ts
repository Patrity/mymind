// app/composables/useVoice.ts
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'
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

  let ws: WebSocket | null = null
  let vad: { start: () => Promise<void>; destroy: () => Promise<void> } | null = null
  let audioCtx: AudioContext | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null
  let playCursor = 0
  let sources: AudioBufferSourceNode[] = []

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) last.text += (/\S$/.test(last.text) && /^\w/.test(delta) ? ' ' : '') + delta
    else transcript.value.push({ role, text: delta })
  }

  function stopPlayback() {
    for (const s of sources) {
      try { s.stop() } catch { /* already stopped */ }
      try { s.disconnect() } catch { /* already disconnected */ }
    }
    sources = []
    playCursor = 0
  }

  async function playWav(bytes: ArrayBuffer) {
    if (!audioCtx || !outAnalyser) return
    try {
      const buf = await audioCtx.decodeAudioData(bytes.slice(0))
      const node = audioCtx.createBufferSource()
      node.buffer = buf
      node.playbackRate.value = TUNING.playbackRate
      node.connect(outAnalyser)
      const at = Math.max(audioCtx.currentTime, playCursor)
      node.start(at)
      playCursor = at + buf.duration / TUNING.playbackRate
      sources.push(node)
      node.onended = () => { sources = sources.filter(s => s !== node) }
    } catch { /* skip undecodable */ }
  }

  async function start() {
    error.value = null

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
    ws.onopen = () => { connected.value = true }
    ws.onclose = () => { connected.value = false; state.value = 'idle' }
    ws.onerror = () => { error.value = 'WebSocket error' }
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        state.value = 'speaking'
        playWav(e.data)
      } else {
        const m = JSON.parse(e.data as string) as { type: string; role?: 'user' | 'assistant'; text?: string; state?: string }
        if (m.type === 'transcript' && m.role && m.text) pushDelta(m.role, m.text)
        else if (m.type === 'state') state.value = m.state === 'speaking' ? 'speaking' : m.state === 'thinking' ? 'thinking' : 'idle'
      }
    }

    vad = await MicVAD.new({
      positiveSpeechThreshold: TUNING.positiveSpeechThreshold,
      negativeSpeechThreshold: TUNING.negativeSpeechThreshold,
      minSpeechMs: TUNING.minSpeechMs,
      redemptionMs: TUNING.redemptionMs,
      onSpeechStart: () => {
        if (TUNING.bargeInEnabled && state.value === 'speaking') {
          stopPlayback()
          ws?.send(JSON.stringify({ type: 'interrupt' }))
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
    audioCtx?.close()
    vad = null
    ws = null
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
    setVoice: (provider: string, voice: string) => ws?.send(JSON.stringify({ type: 'voice', provider, voice })),
    micAnalyser: () => micAnalyser,
    outAnalyser: () => outAnalyser,
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
