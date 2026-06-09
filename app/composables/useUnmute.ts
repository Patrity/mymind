// app/composables/useUnmute.ts
import type RecorderType from 'opus-recorder'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface TranscriptEntry { role: 'user' | 'assistant', text: string }

export interface VoiceOption { id: string, label: string }

// Fallback catalog only — the real list is fetched live from Unmute's
// /api/v1/voices when CORS allows. The voice ID is the `path_on_server`.
// NOTE: prefer NEUTRAL samples (calm/narration/default) — emotional samples
// (happy/amazement/adoration) make the TTS speak with exaggerated, stretched
// prosody ("Heeeyyyy!"). Long samples (…_674s/_1143s) give better conditioning.
const FALLBACK_VOICES: VoiceOption[] = [
  { id: 'expresso/ex03-ex01_calm_001_channel1_1143s.wav', label: 'Calm' },
  { id: 'expresso/ex03-ex02_narration_001_channel1_674s.wav', label: 'Narration' },
  { id: 'expresso/ex04-ex03_default_002_channel2_239s.wav', label: 'Neutral' },
  { id: 'vctk/p270_023.wav', label: 'British (VCTK)' },
  { id: 'expresso/ex04-ex02_happy_001_channel1_118s.wav', label: 'Happy (expressive)' }
]

export function useUnmute() {
  const config = useRuntimeConfig()
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)
  const voices = ref<VoiceOption[]>([...FALLBACK_VOICES])
  const voice = ref<string>(FALLBACK_VOICES[0]!.id)

  // Fetch the live voice catalog from Unmute (derive the http voices URL from the
  // ws realtime URL) so the picker reflects the rig's current voices.yaml.
  async function loadVoices() {
    const wsUrl = config.public.unmuteUrl as string
    if (!wsUrl) return
    const httpUrl = wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/realtime\/?$/, '/voices')
    try {
      const data = await $fetch<unknown>(httpUrl)
      const list = (Array.isArray(data) ? data : (data as { voices?: unknown[] })?.voices ?? []) as Array<{
        name?: string, path_on_server?: string, source?: { path_on_server?: string }
      }>
      const mapped = list
        .map(v => ({ id: v.source?.path_on_server ?? v.path_on_server ?? '', label: v.name ?? v.source?.path_on_server ?? v.path_on_server ?? '' }))
        .filter(v => v.id)
      if (mapped.length) {
        voices.value = mapped
        if (!mapped.some(v => v.id === voice.value)) voice.value = mapped[0]!.id
      }
    } catch { /* keep fallback catalog */ }
  }
  loadVoices()

  let ws: WebSocket | null = null
  let audioCtx: AudioContext | null = null
  let recorder: RecorderType | null = null
  let micStream: MediaStream | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null

  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

  // Unmute/Kyutai emits word-level transcript deltas, often with no surrounding
  // whitespace. Insert a space before a token that starts a new word, unless the
  // running text already ends in whitespace (handles deltas that DO include a space).
  function needsSpace(prev: string, delta: string): boolean {
    return prev.length > 0 && !/\s$/.test(prev) && /^[A-Za-z0-9([{"]/.test(delta)
  }

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    if (!delta) return
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) {
      last.text += (needsSpace(last.text, delta) ? ' ' : '') + delta
    } else {
      transcript.value.push({ role, text: delta.replace(/^\s+/, '') })
    }
  }

  function sessionUpdate() {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: { type: 'constant', text: 'You are MyMind, a concise voice assistant.', language: null },
        voice: voice.value,
        allow_recording: false
      }
    }))
  }

  /** Change the assistant voice; applies live mid-session (Unmute re-reads it). */
  function setVoice(id: string) {
    voice.value = id
    sessionUpdate()
  }

  async function start() {
    if (ws || audioCtx) return
    error.value = null
    const url = config.public.unmuteUrl as string
    if (!url) {
      error.value = 'NUXT_PUBLIC_UNMUTE_URL is not set'
      return
    }

    audioCtx = new AudioContext()
    outAnalyser = audioCtx.createAnalyser()
    outAnalyser.fftSize = 256
    outAnalyser.connect(audioCtx.destination) // connect once; sources feed the analyser

    ws = new WebSocket(url, ['realtime'])
    ws.onopen = () => {
      connected.value = true
      sessionUpdate()
      startMic().catch((e) => {
        error.value = String(e)
      })
    }
    ws.onclose = () => {
      connected.value = false
      state.value = 'idle'
    }
    ws.onerror = () => {
      error.value = 'WebSocket error'
    }
    ws.onmessage = e => handleEvent(JSON.parse(e.data))
  }

  async function startMic() {
    const { default: Recorder } = await import('opus-recorder')
    // Echo cancellation stops the mic from hearing the assistant's own TTS (which
    // otherwise makes the server VAD self-interrupt); noise suppression drops steady
    // ambient noise. autoGainControl OFF so quiet rooms don't get boosted into "speech".
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    })
    const src = audioCtx!.createMediaStreamSource(micStream)
    micAnalyser = audioCtx!.createAnalyser()
    micAnalyser.fftSize = 256
    src.connect(micAnalyser)

    recorder = new Recorder({
      encoderFrameSize: 20,
      encoderSampleRate: 24000,
      maxFramesPerPage: 2,
      numberOfChannels: 1,
      encoderApplication: 2049,
      streamPages: true,
      bufferLength: Math.round((960 * audioCtx!.sampleRate) / 24000),
      encoderPath: '/opus/encoderWorker.min.js',
      mediaTrackConstraints: true
    })
    recorder.ondataavailable = (page: Uint8Array) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toB64(page.buffer as ArrayBuffer) }))
      }
    }
    await recorder.start()
  }

  // ---- assistant audio playback -------------------------------------------
  // ONE persistent decoder for the whole session (recreating it per turn — or
  // sending it `done` — leaves later turns silent). Pages stream in as Ogg/Opus;
  // the worker yields Float32 PCM which we schedule gaplessly. `muted` drops any
  // PCM that decodes after a barge-in / turn switch so stale audio never plays.
  let decoderWorker: Worker | null = null
  let playCursor = 0
  let activeSources: AudioBufferSourceNode[] = []
  let muted = false

  function ensureDecoder() {
    if (decoderWorker || !audioCtx) return
    const w = new Worker('/opus/decoderWorker.min.js')
    w.onmessage = (e: MessageEvent) => {
      const channels = e.data as Float32Array[] | null
      if (muted || !channels || channels.length === 0 || !audioCtx || !outAnalyser) return
      const frames = channels[0]?.length ?? 0
      if (frames === 0) return
      const buf = audioCtx.createBuffer(channels.length, frames, audioCtx.sampleRate)
      for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c]! as Float32Array<ArrayBuffer>, c)
      const node = audioCtx.createBufferSource()
      node.buffer = buf
      node.connect(outAnalyser)
      const startAt = Math.max(audioCtx.currentTime, playCursor)
      node.start(startAt)
      playCursor = startAt + buf.duration
      activeSources.push(node)
      node.onended = () => { activeSources = activeSources.filter(n => n !== node) }
    }
    w.postMessage({
      command: 'init',
      decoderSampleRate: 24000,
      outputBufferSampleRate: audioCtx.sampleRate,
      resampleQuality: 0,
      numberOfChannels: 1,
      bufferLength: 960 // small => the last (unflushed) chunk of each turn is tiny
    })
    decoderWorker = w
  }

  function stopPlayback() {
    muted = true // drop in-flight PCM from the turn we're cutting off
    for (const n of activeSources) {
      try { n.stop() } catch { /* already stopped */ }
      try { n.disconnect() } catch { /* already disconnected */ }
    }
    activeSources = []
    playCursor = 0
  }

  function decodeOpus(bytes: Uint8Array) {
    ensureDecoder()
    muted = false // fresh audio for the current turn — accept it
    decoderWorker?.postMessage({ command: 'decode', pages: bytes }, [bytes.buffer])
  }

  function handleEvent(ev: { type: string, delta?: string, audio?: string }) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        state.value = 'listening'
        break
      case 'input_audio_buffer.speech_stopped':
        state.value = 'thinking'
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.delta) pushDelta('user', ev.delta)
        break
      case 'response.created':
        state.value = 'thinking'
        stopPlayback() // clear any prior turn's tail; keep the decoder alive
        break
      case 'response.text.delta':
        if (ev.delta) pushDelta('assistant', ev.delta)
        break
      case 'response.audio.delta':
        state.value = 'speaking'
        if (ev.delta) decodeOpus(fromB64(ev.delta))
        break
      case 'response.audio.done':
        state.value = 'idle'
        break
      case 'unmute.interrupted_by_vad':
        stopPlayback() // barge-in: cut the assistant off immediately
        state.value = 'listening'
        break
    }
  }

  function stop() {
    recorder?.stop().catch(() => {})
    stopPlayback()
    decoderWorker?.terminate()
    decoderWorker = null
    ws?.close()
    audioCtx?.close()
    micStream?.getTracks().forEach(t => t.stop())
    micStream = null
    recorder = null
    ws = null
    audioCtx = null
    state.value = 'idle'
    connected.value = false
  }

  onUnmounted(stop)

  return {
    state, connected, transcript, error, voice, voices,
    start, stop, setVoice,
    micAnalyser: () => micAnalyser, outAnalyser: () => outAnalyser
  }
}
