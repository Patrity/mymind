// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { VizEvent } from '../viz/types'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string }

export interface MsgEffect {
  state?: 'idle' | 'thinking' | 'speaking' | 'tool'
  delta?: { role: 'user' | 'assistant'; text: string }
  events: VizEvent[]
}

export function mapServerMessage(m: ServerMsg, isPlaying: boolean): MsgEffect {
  const events: VizEvent[] = []
  if (m.type === 'transcript' && m.role && m.text) {
    if (m.role === 'user') events.push({ type: 'sttFinal', chars: m.text.length })
    return { delta: { role: m.role, text: m.text }, events }
  }
  if (m.type === 'state') {
    if (m.state === 'speaking') return { state: 'speaking', events }
    if (m.state === 'thinking') return { state: 'thinking', events }
    if (m.state === 'tool') return { state: 'tool', events }
    // Server says idle the moment generation ends, but audio may still be
    // buffered ahead — playback drain flips to idle in that case (useVoice).
    return isPlaying ? { events } : { state: 'idle', events }
  }
  return { events }
}
