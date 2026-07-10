// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { VizEvent } from '../viz/types'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string; message?: string; requestId?: string; tool?: string; command?: string; proposedPattern?: string; name?: string; summary?: string; undoToken?: string }

export interface MsgEffect {
  // 'listening'/'connecting' never come from the server (client VAD / WS dial own
  // them), and the 'disconnected' viz event is emitted by useVoice.onclose — not here.
  state?: 'idle' | 'thinking' | 'speaking' | 'tool' | 'typing'
  delta?: { role: 'user' | 'assistant'; text: string }
  reasoning?: string
  /** A completed tool call — rendered INLINE in the transcript at stream position. */
  tool?: { name: string; summary: string; undoToken?: string }
  error?: string
  events: VizEvent[]
  approval?: { requestId: string; tool: string; command: string; proposedPattern: string }
  approvalResolved?: string // requestId that was settled server-side (timeout)
}

export function mapServerMessage(m: ServerMsg, isPlaying: boolean): MsgEffect {
  const events: VizEvent[] = []
  if (m.type === 'transcript' && m.role && m.text) {
    if (m.role === 'user') events.push({ type: 'sttFinal', chars: m.text.length })
    return { delta: { role: m.role, text: m.text }, events }
  }
  if (m.type === 'reasoning' && m.text) {
    return { reasoning: m.text, events }
  }
  // Tool result event — surfaced inline so the transcript shows WHERE in the
  // reply each tool ran (previously collected out-of-band at the bottom).
  if (m.type === 'tool' && m.name && m.summary) {
    return { tool: { name: m.name, summary: m.summary, undoToken: m.undoToken }, events }
  }
  if (m.type === 'error') {
    return { error: m.message || 'Voice error', events: [{ type: 'error' }] }
  }
  if (m.type === 'state') {
    if (m.state === 'speaking') return { state: 'speaking', events }
    if (m.state === 'thinking') return { state: 'thinking', events }
    if (m.state === 'tool') return { state: 'tool', events }
    if (m.state === 'typing') return { state: 'typing', events }
    // Server says idle the moment generation ends, but audio may still be
    // buffered ahead — playback drain flips to idle in that case (useVoice).
    return isPlaying ? { events } : { state: 'idle', events }
  }
  if (m.type === 'approval' && m.requestId && m.command) {
    return { approval: { requestId: m.requestId, tool: m.tool ?? 'exec', command: m.command, proposedPattern: m.proposedPattern ?? '' }, events }
  }
  if (m.type === 'approval-resolved' && m.requestId) {
    return { approvalResolved: m.requestId, events }
  }
  return { events }
}
