// app/composables/useVoice.ts
import { createEmitter } from '../lib/viz/emitter'
import { mapServerMessage } from '../lib/voice/messages'
import type { VizEvent } from '../lib/viz/types'
import type { AttachmentRef, MessageUsage } from '~~/shared/types/conversation'

export type VoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool' | 'typing'
// `id` is a stable per-entry key: it keys v-for AND the MdView/MDC parse cache —
// without a unique cache key, streaming entries that start with the same first
// delta collide on MDC's hash(value) asyncData key and mirror each other's text.
// role 'tool' entries are inline tool-call chips (name/summary/undoToken set, text unused).
export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  attachments?: AttachmentRef[]
  name?: string
  summary?: string
  undoToken?: string
  undone?: boolean
  reasoning?: string
  /** ISO timestamp — display only. Set when a live entry is first created; carried
   *  over from the DTO on resume. */
  createdAt?: string
  /** Token usage for this entry's assistant turn. `undefined`/absent (not a zeroed
   *  object) for entries written before the usage column existed, or a turn the
   *  server never reported usage for — the UI must render nothing, not a fake 0. */
  usage?: MessageUsage | null
}

export function newEntryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

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
  const pendingApproval = ref<{ requestId: string; tool: string; command: string; proposedPattern: string } | null>(null)
  /**
   * The thread this connection is in. Written from three places and nowhere else:
   * the server's `conversation` frame (first turn of a NEW thread — the only way the
   * client can learn the id/title the server derived), the page after a successful
   * resume, and newConversation() which clears both.
   */
  const conversationId = ref<string | null>(null)
  const conversationTitle = ref<string | null>(null)
  const { settings } = useVoiceSettings()

  const events = createEmitter<VizEvent>()

  let pendingUserAttachments: AttachmentRef[] = []
  let ws: WebSocket | null = null
  // Last voice the user picked. Selecting before connecting (the natural UX) would
  // otherwise be lost — ws is null then, so we remember it and (re)send on open.
  let desiredVoice: { provider: string; voice: string } | null = null
  // Last reasoning-model override the user picked (navbar dropdown, ephemeral —
  // not persisted server-side). null = default chain order. Resent on (re)open
  // for the same reason as desiredVoice: picking before/across a reconnect.
  let desiredModel: string | null = null
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
    // Append raw — LLM/STT text deltas already carry their own spacing and
    // concatenate to the exact string. (An earlier word-boundary space heuristic
    // mangled sub-word token streaming, e.g. "Brid"+"get" → "Brid get".)
    // A tool entry between deltas breaks the same-role run, so assistant text
    // resumes in a NEW bubble after each inline tool chip — true stream order.
    if (last && last.role === role) last.text += delta
    else {
      transcript.value.push({ id: newEntryId(), role, text: delta, createdAt: new Date().toISOString(), attachments: role === 'user' && pendingUserAttachments.length ? pendingUserAttachments : undefined })
      if (role === 'user') pendingUserAttachments = []
    }
  }

  function pushReasoning(text: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === 'assistant') last.reasoning = (last.reasoning ?? '') + text
    else transcript.value.push({ id: newEntryId(), role: 'assistant', text: '', createdAt: new Date().toISOString(), reasoning: text })
  }

  function pushTool(t: { name: string; summary: string; undoToken?: string }) {
    transcript.value.push({ id: newEntryId(), role: 'tool', text: '', ...t })
  }

  // Usage arrives once per turn (see run.ts/ws.ts), after all of that turn's text/tool
  // entries have already been pushed. It describes the whole assistant turn, so attach
  // it to the LAST assistant-role entry — mirroring buildResumeTranscript, which after a
  // reload attaches the persisted message's usage to its trailing (last) split entry.
  // Walking back past interleaved tool chips lets it land correctly even when the turn's
  // final action was a tool call with no trailing assistant text.
  function setUsage(usage: MessageUsage) {
    for (let i = transcript.value.length - 1; i >= 0; i--) {
      const e = transcript.value[i]!
      if (e.role === 'assistant') { e.usage = usage; return }
      if (e.role === 'user') return // don't reach back into a previous turn
    }
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

  // Bumped on every disconnect(): async startup steps (VAD model/wasm fetches can take
  // seconds over WAN) bail out when their session is stale instead of constructing
  // audio nodes on a closed AudioContext ("No execution context available").
  let session = 0

  /**
   * Connect: build AudioContext (for playback) + open the WS. Does NOT start the
   * VAD or request mic permission. Safe to call from a text-first UI without ever
   * prompting for mic access.
   */
  // De-dupes concurrent connect() calls and lets callers `await` until the WS is
  // actually OPEN (connectInner resolves on `onopen`) — so a typed send right after
  // connect() never races the handshake.
  let connecting: Promise<void> | null = null

  async function connect() {
    if (connected.value) return
    if (connecting) return connecting
    error.value = null
    state.value = 'connecting'
    const mySession = ++session
    connecting = connectInner(mySession)
      .catch((err) => {
        if (mySession !== session) return // torn down mid-start — disconnect() already cleaned up
        // WS setup failure would otherwise strand the UI in 'connecting'.
        error.value = err instanceof Error ? err.message : 'Voice startup failed'
        events.emit({ type: 'error' })
        disconnect()
      })
      .finally(() => { connecting = null })
    await connecting
  }

  async function connectInner(mySession: number) {
    audioCtx = new AudioContext()
    outAnalyser = audioCtx.createAnalyser()
    outAnalyser.fftSize = 256
    outAnalyser.connect(audioCtx.destination)
    micAnalyser = audioCtx.createAnalyser()
    micAnalyser.fftSize = 256

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${proto}://${location.host}/api/voice/ws`)
    socket.binaryType = 'arraybuffer'
    ws = socket
    socket.onclose = () => { connected.value = false; state.value = 'idle'; events.emit({ type: 'disconnected' }) }
    socket.onerror = () => { error.value = 'WebSocket error'; events.emit({ type: 'error' }) }
    socket.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        state.value = 'speaking'
        enqueueWav(e.data)
      } else {
        const fx = mapServerMessage(JSON.parse(e.data as string), isPlaying())
        if (fx.delta) pushDelta(fx.delta.role, fx.delta.text)
        if (fx.reasoning) pushReasoning(fx.reasoning)
        if (fx.tool) pushTool(fx.tool)
        if (fx.usage) setUsage(fx.usage)
        if (fx.state) state.value = fx.state
        if (fx.error) error.value = fx.error
        for (const ev of fx.events) events.emit(ev)
        if (fx.approval) pendingApproval.value = fx.approval
        if (fx.approvalResolved && pendingApproval.value?.requestId === fx.approvalResolved) pendingApproval.value = null
        if (fx.conversation) {
          conversationId.value = fx.conversation.id
          conversationTitle.value = fx.conversation.title
        }
      }
    }
    // Resolve only once the socket is OPEN. A pre-open error/close rejects → connect()'s
    // catch tears down + surfaces the error. (Post-open errors/closes are handled by the
    // persistent handlers above; the once-listeners reject an already-settled promise = no-op.)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        connected.value = true
        state.value = 'idle'
        // Apply the persisted voice choice (and re-apply on reconnect).
        const v = desiredVoice ?? { provider: settings.value.provider, voice: settings.value.voice }
        socket.send(JSON.stringify({ type: 'voice', ...v }))
        if (desiredModel) socket.send(JSON.stringify({ type: 'model', modelDefId: desiredModel }))
        resolve()
      }
      socket.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true })
      socket.addEventListener('close', () => reject(new Error('WebSocket closed before open')), { once: true })
    })
    // connectInner does NOT call startVad — call enableMic() separately for mic input.
    if (mySession !== session) return // disconnect() landed while setting up
  }

  /**
   * Enable microphone input: start the VAD + getUserMedia. Requires the WS to be
   * connected first (`connected.value === true`). No-op if VAD is already running.
   * Returns whether the mic actually started — callers must not flip their own
   * "mic on" state on a bare await, since a denied permission or missing device
   * rejects inside startVad() and is swallowed here into `error` rather than thrown.
   */
  async function enableMic(): Promise<boolean> {
    if (vad) return true
    if (!connected.value) return false
    const mySession = session
    try {
      await startVad(mySession)
      return true
    } catch (err) {
      if (mySession !== session) return false
      error.value = err instanceof Error ? err.message : 'Mic startup failed'
      events.emit({ type: 'error' })
      return false
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
    if (current !== session) return // disconnect() raced us
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
        const baseAudio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
        const deviceId = settings.value.micDeviceId
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...baseAudio,
            // '' means "let the OS choose". An explicit id is `exact` so a stale
            // selection fails loudly here rather than silently using the wrong mic.
            ...(deviceId ? { deviceId: { exact: deviceId } } : {})
          }
        }).catch(async (err: Error) => {
          // A device that has been unplugged since it was chosen throws
          // OverconstrainedError. Fall back to the default rather than leaving the
          // user with a dead microphone and no explanation.
          if (err.name !== 'OverconstrainedError') throw err
          settings.value = { ...settings.value, micDeviceId: '' }
          error.value = 'That microphone is no longer available — switched to the system default.'
          return navigator.mediaDevices.getUserMedia({ audio: baseAudio })
        })
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
    if (mySession !== session) return // disconnect() landed mid-restart
    vad = null
    vizStream?.getTracks().forEach(t => t.stop())
    vizStream = null
    speechProb.value = 0
    await startVad(mySession)
  }

  /** Full teardown: closes the VAD, WS, and AudioContext. Unlike stop() (below,
   *  exposed to callers), this ends the session rather than just the running turn. */
  function disconnect() {
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

  onUnmounted(disconnect)

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
    /** Full teardown: closes VAD/WS/AudioContext. Called automatically on unmount. */
    disconnect,
    /** Abort the running turn. Same frame the VAD barge-in path sends — until now
     *  a typed turn had no way to reach it and ran to completion. Leaves the WS and
     *  AudioContext connected (unlike disconnect()). */
    stop() {
      ws?.send(JSON.stringify({ type: 'interrupt' }))
      stopPlayback()
      state.value = 'idle'
    },
    setVoice: (provider: string, voice: string) => {
      desiredVoice = { provider, voice }
      settings.value = { ...settings.value, provider, voice } // persist the pick
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice', provider, voice }))
    },
    /**
     * Override the reasoning model for this connection (null = default chain
     * order). Ephemeral — not persisted server-side; the caller cookie-persists
     * the pick and re-applies it via this same setter after connect/reconnect.
     */
    setModel: (modelDefId: string | null) => {
      desiredModel = modelDefId
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'model', modelDefId }))
    },
    speechProb,
    applyVadSettings,
    /**
     * Send a typed turn through the voice loop. Pass speak=true to have the
     * agent answer aloud; speak=false (default) for text-only response.
     * Auto-connects the WS transparently if needed — a chat "just works" without
     * an explicit Connect step. Returns false only if connecting fails.
     */
    sendText: async (text: string, speak = false, attachments: AttachmentRef[] = []): Promise<boolean> => {
      const t = text.trim()
      if (!t && !attachments.length) return false
      if (ws?.readyState !== WebSocket.OPEN) await connect()
      if (ws?.readyState !== WebSocket.OPEN) return false
      if (isPlaying()) { stopPlayback(); events.emit({ type: 'bargein' }) } // typed barge-in
      pendingUserAttachments = attachments
      ws.send(JSON.stringify({ type: 'text', text: t, speak, attachments }))
      return true
    },
    /**
     * Resume a previous conversation by ID. Auto-connects if needed. The page
     * hydrates the transcript from the HTTP fetch (see T8).
     */
    loadConversation: async (id: string) => {
      if (ws?.readyState !== WebSocket.OPEN) await connect()
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'load', conversationId: id }))
    },
    /**
     * Start a fresh conversation: signals the server to reset context and
     * clears the local transcript.
     */
    newConversation: () => {
      transcript.value = []
      conversationId.value = null
      conversationTitle.value = null
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'new' }))
    },
    conversationId,
    conversationTitle,
    micAnalyser: () => micAnalyser,
    outAnalyser: () => outAnalyser,
    onVizEvent: events.on,
    pendingApproval,
    sendApproval: (requestId: string, approved: boolean, opts?: { remember?: boolean; pattern?: string }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: approved ? 'approve' : 'deny', requestId, remember: opts?.remember, pattern: opts?.pattern }))
      }
      if (pendingApproval.value?.requestId === requestId) pendingApproval.value = null
    },
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
