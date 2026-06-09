// app/composables/useUnmute.ts
import type RecorderType from 'opus-recorder'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface TranscriptEntry { role: 'user' | 'assistant', text: string }

export function useUnmute() {
  const config = useRuntimeConfig()
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let audioCtx: AudioContext | null = null
  let recorder: RecorderType | null = null
  let micStream: MediaStream | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null

  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) last.text += delta
    else transcript.value.push({ role, text: delta })
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

    ws = new WebSocket(url, ['realtime'])
    ws.onopen = () => {
      connected.value = true
      ws!.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: { type: 'constant', text: 'You are MyMind, a concise voice assistant.', language: null },
          voice: 'unmute-prod-website/developer-1.mp3',
          allow_recording: false
        }
      }))
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
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      mediaTrackConstraints: true
    })
    recorder.ondataavailable = (page: Uint8Array) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toB64(page.buffer as ArrayBuffer) }))
      }
    }
    await recorder.start()
  }

  let playCursor = 0
  async function playOpus(bytes: Uint8Array) {
    // opus-recorder ships a decoder worklet; for v1 we decode via WebAudio
    // decodeAudioData on the Ogg/Opus page. If decodeAudioData rejects on raw
    // streamed pages, switch to opus-recorder's decoder worklet (wiki §6/§10).
    try {
      const buf = await audioCtx!.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer)
      const node = audioCtx!.createBufferSource()
      node.buffer = buf
      node.connect(outAnalyser!)
      outAnalyser!.connect(audioCtx!.destination)
      const startAt = Math.max(audioCtx!.currentTime, playCursor)
      node.start(startAt)
      playCursor = startAt + buf.duration
    } catch { /* ignore undecodable page */ }
  }

  function flushPlayback() {
    playCursor = 0
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
        break
      case 'response.text.delta':
        if (ev.delta) pushDelta('assistant', ev.delta)
        break
      case 'response.audio.delta':
        state.value = 'speaking'
        if (ev.delta) playOpus(fromB64(ev.delta))
        break
      case 'response.audio.done':
        state.value = 'idle'
        break
      case 'unmute.interrupted_by_vad':
        flushPlayback()
        state.value = 'listening'
        break
    }
  }

  function stop() {
    recorder?.stop().catch(() => {})
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

  return { state, connected, transcript, error, start, stop, micAnalyser: () => micAnalyser, outAnalyser: () => outAnalyser }
}
