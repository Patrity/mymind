// server/api/voice/ws.ts
import { handleUtterance } from '../../lib/voice/orchestrator'
import { classifyFrame } from '../../lib/voice/frames'
import { makeStt, makeTts, defaultVoice, type TtsName } from '../../lib/voice/providers'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import type { AgentMessage } from '../../lib/agent/run'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} | {type:'voice',provider,voice}
// Server→client: binary = audio bytes | text JSON = transcript/tool/state events.
interface ConnState { history: AgentMessage[]; ac: AbortController | null; provider: TtsName; voice: string; lock: Promise<void> }
const conns = new WeakMap<object, ConnState>()

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    const provider = VOICE_TUNING.tts.provider
    conns.set(peer, { history: [], ac: null, provider, voice: defaultVoice(provider), lock: Promise.resolve() })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'control') {
      const msg = frame.msg
      if (msg.type === 'interrupt') s.ac?.abort()
      else if (msg.type === 'voice') { s.provider = msg.provider as TtsName; s.voice = msg.voice as string }
      return
    }
    if (frame.kind === 'ignore') return
    const audio = frame.bytes
    s.ac?.abort()
    s.ac = new AbortController()
    const ac = s.ac
    const run = async () => {
      try {
        s.history = await handleUtterance(audio, s.history, {
          stt: makeStt(), tts: makeTts(s.provider), voice: s.voice, signal: ac.signal,
          emit: (e) => { if (e.type === 'audio') peer.send(e.bytes); else peer.send(JSON.stringify(e)) }
        })
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
