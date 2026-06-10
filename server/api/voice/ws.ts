// server/api/voice/ws.ts
import { handleUtterance, handleTurn, type VoiceEvent } from '../../lib/voice/orchestrator'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel, ttsFromModel } from '../../lib/voice/providers'
import type { SttProvider, TtsProvider } from '../../lib/voice/providers/types'
import { withFailover } from '../../lib/ai/registry/resolve'
import type { AgentMessage } from '../../lib/agent/run'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} |
//   {type:'voice',voice} | {type:'text',text} (typed turn, injected post-STT)
// Server→client: binary = audio bytes | text JSON = transcript/tool/state/error events.
interface ConnState { history: AgentMessage[]; ac: AbortController | null; voice: string; lock: Promise<void> }
const conns = new WeakMap<object, ConnState>()

// STT/TTS resolved from the registry at call time, with per-usage failover.
const stt: SttProvider = {
  transcribe: (audio, opts) =>
    withFailover('stt', m => sttFromModel(m).transcribe(audio, opts))
}
const tts: TtsProvider = {
  synthesize: (text, opts) => ttsSynthFailover(text, opts)
}

async function* ttsSynthFailover(text: string, opts: { voice: string; signal?: AbortSignal }) {
  // Pick the first reachable TTS provider, then stream from it.
  const provider = await withFailover('tts', async (m) => ttsFromModel(m))
  yield* provider.synthesize(text, opts)
}

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    conns.set(peer, { history: [], ac: null, voice: '', lock: Promise.resolve() })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return
    // A turn closure reads s.history at EXECUTION time (under the lock), so
    // back-to-back turns see each other's appended messages.
    let turn: ((signal: AbortSignal, emit: (e: VoiceEvent) => void) => Promise<AgentMessage[]>) | null = null
    if (frame.kind === 'control') {
      const msg = frame.msg
      if (msg.type === 'interrupt') { s.ac?.abort(); return }
      if (msg.type === 'voice') { s.voice = msg.voice as string; return }
      if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // Typed turn: inject post-STT — same agent loop, same TTS, same events.
        const text = msg.text.trim()
        turn = (signal, emit) => handleTurn(text, s.history, { tts, voice: s.voice, signal, emit })
      } else {
        return
      }
    } else {
      const audio = frame.bytes
      turn = (signal, emit) => handleUtterance(audio, s.history, { stt, tts, voice: s.voice, signal, emit })
    }
    s.ac?.abort()
    s.ac = new AbortController()
    const ac = s.ac
    const exec = turn
    const run = async () => {
      try {
        s.history = await exec(ac.signal, (e) => { if (e.type === 'audio') peer.send(e.bytes); else peer.send(JSON.stringify(e)) })
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // Surface pipeline failures to the client (error flash + message) instead
        // of dying as an unhandledRejection on the lock chain.
        console.error('[voice] utterance failed:', err)
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'voice pipeline error' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
    }
    s.lock = s.lock.then(run, run)
  },
  close(peer) { conns.get(peer)?.ac?.abort(); conns.delete(peer) }
})
