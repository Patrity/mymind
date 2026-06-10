// server/api/voice/ws.ts
import { handleUtterance } from '../../lib/voice/orchestrator'
import { makeStt, makeTts, defaultVoice, type TtsName } from '../../lib/voice/providers'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import type { AgentMessage } from '../../lib/agent/run'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} | {type:'voice',provider,voice}
// Server→client: binary = audio bytes | text JSON = transcript/tool/state events.
interface ConnState { history: AgentMessage[]; ac: AbortController | null; provider: TtsName; voice: string; lock: Promise<void> }
const conns = new WeakMap<object, ConnState>()

export default defineWebSocketHandler({
  open(peer) {
    const provider = VOICE_TUNING.tts.provider
    conns.set(peer, { history: [], ac: null, provider, voice: defaultVoice(provider), lock: Promise.resolve() })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    if (typeof message.rawData === 'string') {
      const msg = JSON.parse(message.text())
      if (msg.type === 'interrupt') s.ac?.abort()
      else if (msg.type === 'voice') { s.provider = msg.provider as TtsName; s.voice = msg.voice }
      return
    }
    const audio = message.uint8Array()
    s.ac?.abort()
    s.ac = new AbortController()
    const ac = s.ac
    const run = async () => {
      s.history = await handleUtterance(audio, s.history, {
        stt: makeStt(), tts: makeTts(s.provider), voice: s.voice, signal: ac.signal,
        emit: (e) => { if (e.type === 'audio') peer.send(e.bytes); else peer.send(JSON.stringify(e)) }
      })
    }
    s.lock = s.lock.then(run, run)
  },
  close(peer) { conns.get(peer)?.ac?.abort(); conns.delete(peer) }
})
