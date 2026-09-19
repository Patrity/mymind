// app/composables/useVoice.ts
import { mapServerMessage } from '../lib/voice/messages'
import { createPlaybackEpochs } from '../lib/voice/playback-epoch'
import { createClientTurns } from '../lib/agent/turn-stream'
import type { AttachmentRef } from '~~/shared/types/conversation'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

export type VoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool' | 'typing'

// Capture/barge-in/playback knobs are user-tunable and cookie-persisted —
// see useVoiceSettings. NOTE: vad-web 0.0.30 uses time-based options
// (minSpeechMs, redemptionMs) rather than frame-based ones.

export function useVoice() {
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const messages = ref<AgentUIMessage[]>([])
  // One readUIMessageStream per turn (lib/agent/turn-stream.ts). upsert replaces a message by
  // id (a streamed snapshot) or appends it (a new user/assistant message).
  const turns = createClientTurns({
    upsert: (m) => {
      const list = messages.value
      const i = list.findIndex(x => x.id === m.id)
      if (i >= 0) list.splice(i, 1, m)
      else list.push(m)
    }
  })
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

  let ws: WebSocket | null = null
  // Last preset the user picked. Selecting before connecting (the natural UX) would
  // otherwise be lost — ws is null then, so we remember it and (re)send on open.
  let desiredPreset: string | null = null
  // Last reasoning-model override the user picked (navbar dropdown, ephemeral —
  // not persisted server-side). null = default chain order. Resent on (re)open
  // for the same reason as desiredPreset: picking before/across a reconnect.
  let desiredModel: string | null = null
  let vad: { start: () => Promise<void>; destroy: () => Promise<void> } | null = null
  let audioCtx: AudioContext | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null
  let vizStream: MediaStream | null = null
  let playCursor = 0
  let sources: AudioBufferSourceNode[] = []
  // Invalidates chunks belonging to a turn that has since been barged in on. The rule and
  // the race it defends against live in lib/voice/playback-epoch.ts, where they are tested
  // — this guard was dead for a whole cycle because it was not.
  const epochs = createPlaybackEpochs()
  // Sample rate of the segment being played, from its `audio-begin` frame, and the odd
  // trailing byte of the previous chunk (see enqueuePcm).
  let pcmSampleRate = 24000
  let carry = new Uint8Array(0)

  function stopPlayback() {
    epochs.interrupt() // invalidate any chunks still in flight from the interrupted turn
    carry = new Uint8Array(0) // a half-sample from the killed segment must not lead the next one
    for (const s of sources) {
      try { s.stop() } catch { /* already stopped */ }
      try { s.disconnect() } catch { /* already disconnected */ }
    }
    sources = []
    playCursor = 0
  }

  // True while audio is actually playing or scheduled ahead. The server emits
  // state:'idle' as soon as the agent finishes GENERATING, but the client has by
  // then buffered PCM chunks into the future — so barge-in must key off real
  // playback, not the server-driven state.value.
  function isPlaying(): boolean {
    return sources.length > 0 || (!!audioCtx && playCursor > audioCtx.currentTime + 0.02)
  }

  /**
   * Return the client to rest after telling the SERVER to abort the running turn.
   * The orchestrator returns early the moment its signal is aborted (`if
   * (deps.signal.aborted) return messages`, server/lib/voice/orchestrator.ts) and so
   * never reaches its closing `{state:'idle'}` emit — an aborted turn produces NO idle
   * frame. Nothing else takes the UI out of 'thinking'/'speaking', so every caller that
   * aborts a turn has to do it here. `stop()` always did this inline; `newConversation()`
   * and `loadConversation()` abort exactly the same way (`{type:'new'}` / `{type:'load'}`
   * both call `s.ac?.abort()` in ws.ts) and did not — which left the composer showing
   * "Stop generating" forever (no way to send in the new/resumed thread short of pressing
   * Stop), and left the old thread's TTS playing into it.
   *
   * This is UI COMPENSATION FOR A PROTOCOL GAP, and deliberately so. The race-free fix is
   * server-side: emit a terminal state at the abort exit itself (`orchestrator.ts:202`), so
   * the client is told it is done instead of assuming it. Setting state locally races a
   * late frame from the turn being torn down, which is why this is a compensation and not a
   * cure. It was kept because `stop()` has carried the identical race since cycle 60 — this
   * is not a new hazard — and reopening the voice protocol at the end of cycle 65 was judged
   * the larger risk. `server/lib/voice/orchestrator-abort-exit.test.ts` pins the server
   * behaviour this compensates for: when that test goes red because the abort path started
   * emitting a terminal state, delete this function and let the frame do the work.
   * Tracked as MyMind task `9e5b44da-1003-4d58-9c1c-2af4a2250cb8`.
   */
  function restAfterAbort() {
    stopPlayback()
    state.value = 'idle'
  }

  // Breeze streams headerless PCM (mono / s16le) as it generates, so playback starts on
  // the first chunk instead of waiting for a whole segment. decodeAudioData cannot be
  // used — it needs a container — and its old `catch { /* skip undecodable */ }` swallowed
  // exactly the failure we most need to see.
  //
  // Scheduling uses the AudioContext clock, NOT the 'ended' event: 'ended' fires late and
  // leaves audible gaps between chunks.
  function onAudioBegin(sampleRate: number) {
    pcmSampleRate = sampleRate
    carry = new Uint8Array(0)
    // Stamp the segment with the epoch it was OPENED in. Every PCM frame that follows is
    // checked against this, not against the live `playEpoch` — reading `playEpoch` at the
    // socket handler made the guard in enqueuePcm unfireable, because the value it read
    // and the value it compared to were the same variable read in the same tick.
    //
    // This is what actually drops the barge-in tail. stopPlayback() stops the sources it
    // has ALREADY scheduled, but a frame still in flight when the user interrupts arrives
    // afterwards and would schedule itself onto a cleared playCursor. It belongs to the
    // interrupted segment, so it now carries that segment's stale epoch and is discarded.
    //
    // `audio-begin` now carries the turn id that opened it (see socket.onmessage below),
    // and a segment from a turn the client has already walked away from is rejected
    // outright via epochs.rejectSegment() instead of ever reaching here — the residual
    // window described below is gone for tagged frames. Re-stamping here is still
    // unconditional for whatever frame DOES reach onAudioBegin (i.e. one whose turn is
    // current), for the same reason as before: the interrupt takes one RTT to reach the
    // server, so a segment the server opens for the INTERRUPTED turn inside that window
    // re-opens the gate for that turn's audio. Narrow (serial pipeline, hundreds of ms
    // per segment, ws.ts aborts on the interrupt frame) and strictly better than the dead
    // guard it replaces — but a window, not zero. See lib/voice/playback-epoch.ts.
    epochs.beginSegment()
  }

  /** s16le -> Float32 in [-1, 1] */
  function decodePcm(bytes: Uint8Array): Float32Array<ArrayBuffer> {
    const n = bytes.byteLength >> 1
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }

  function enqueuePcm(data: ArrayBuffer, epoch: number) {
    if (!audioCtx || !outAnalyser || !epochs.accepts(epoch)) return
    // A 16-bit sample must never be split across chunk boundaries: the stream is a byte
    // stream, so a chunk can end mid-sample. Hold that byte back for the next chunk —
    // dropping it would shift every following sample by one byte (loud garbage).
    const incoming = new Uint8Array(data)
    let bytes: Uint8Array
    if (carry.length) {
      bytes = new Uint8Array(carry.length + incoming.length)
      bytes.set(carry, 0); bytes.set(incoming, carry.length)
    } else {
      bytes = incoming
    }
    const usable = bytes.byteLength - (bytes.byteLength % 2)
    carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable)
    if (usable === 0) return

    const samples = decodePcm(bytes.subarray(0, usable))
    const buf = audioCtx.createBuffer(1, samples.length, pcmSampleRate)
    buf.copyToChannel(samples, 0)
    const node = audioCtx.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = settings.value.playbackRate
    node.connect(outAnalyser)
    // Never schedule in the past, or chunks overlap and click.
    const at = Math.max(audioCtx.currentTime + 0.02, playCursor)
    node.start(at)
    playCursor = at + buf.duration / settings.value.playbackRate
    sources.push(node)
    node.onended = () => {
      sources = sources.filter(s => s !== node)
      // Playback fully drained → reflect idle (the server already signalled done).
      if (!isPlaying() && state.value === 'speaking') state.value = 'idle'
    }
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
    socket.onclose = () => { connected.value = false; state.value = 'idle'; turns.disconnect() }
    socket.onerror = () => { error.value = 'WebSocket error' }
    socket.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        state.value = 'speaking'
        enqueuePcm(e.data, epochs.segment())
      } else {
        const fx = mapServerMessage(JSON.parse(e.data as string), isPlaying())
        // audio-begin now names its turn: a segment from a superseded turn is rejected
        // outright (closes the barge-in window documented on onAudioBegin).
        if (fx.audioBegin) {
          if (fx.audioBegin.turnId !== undefined && turns.isStale(fx.audioBegin.turnId)) epochs.rejectSegment()
          else onAudioBegin(fx.audioBegin.sampleRate)
        }
        if (fx.messageFrame) turns.handle(fx.messageFrame)
        if (fx.state) state.value = fx.state
        if (fx.error) error.value = fx.error
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
        // Apply the persisted voice choice (and re-apply on reconnect). '' is valid and
        // means "the server's default preset" — so is an id the server no longer has.
        const p = desiredPreset ?? settings.value.presetId
        socket.send(JSON.stringify({ type: 'preset', presetId: p }))
        if (desiredModel) socket.send(JSON.stringify({ type: 'model', modelDefId: desiredModel }))
        turns.reset()
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
          turns.interrupt()
          ws?.send(JSON.stringify({ type: 'interrupt' }))
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
    messages,
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
      turns.interrupt()
      restAfterAbort()
    },
    setPreset: (presetId: string) => {
      desiredPreset = presetId
      settings.value = { ...settings.value, presetId } // persist the pick
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'preset', presetId }))
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
      if (isPlaying()) stopPlayback() // typed barge-in
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
      restAfterAbort() // the server aborts the running turn for us; nothing sends idle back
    },
    /**
     * Call right before replacing `messages` wholesale (resume, retry): the running turn —
     * if any — is closed and nothing from it is ever upserted into the new list.
     */
    discardTurn: () => turns.discard(),
    /**
     * Start a fresh conversation: signals the server to reset context and
     * clears the local transcript.
     */
    newConversation: () => {
      // discard, not interrupt: interrupt still upserts the running turn's closing snapshot,
      // which would land in the NEW empty list as a "stopped" reply from the old thread.
      turns.discard()
      messages.value = []
      conversationId.value = null
      conversationTitle.value = null
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'new' }))
      restAfterAbort() // the server aborts the running turn for us; nothing sends idle back
    },
    conversationId,
    conversationTitle,
    micAnalyser: () => micAnalyser,
    outAnalyser: () => outAnalyser,
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
