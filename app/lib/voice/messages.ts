// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { VizEvent } from '../viz/types'
import type { AgentMessageFrame } from '~~/shared/types/agent-ui'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string; message?: string; requestId?: string; tool?: string; command?: string; proposedPattern?: string; name?: string; summary?: string; undoToken?: string; conversationId?: string; title?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number; segmentId?: number; sampleRate?: number; turnId?: number }

export interface MsgEffect {
  // 'listening'/'connecting' never come from the server (client VAD / WS dial own
  // them), and the 'disconnected' viz event is emitted by useVoice.onclose — not here.
  state?: 'idle' | 'thinking' | 'speaking' | 'tool' | 'typing'
  /** A `chunk` or `user-message` frame — handed to lib/agent/turn-stream.ts as-is. */
  messageFrame?: AgentMessageFrame
  error?: string
  events: VizEvent[]
  approval?: { requestId: string; tool: string; command: string; proposedPattern: string }
  approvalResolved?: string // requestId that was settled server-side (timeout)
  /** The server lazily created a thread on this turn — id + its derived title. */
  conversation?: { id: string; title: string | null }
  /** A spoken segment is starting: the binary frames that follow are headerless PCM
   *  (mono / s16le) at THIS sample rate — the client cannot decode them without it.
   *  `turnId` names which turn opened it, so a segment from a superseded turn can be
   *  rejected outright (see useVoice's onAudioBegin / turns.isStale). */
  audioBegin?: { segmentId: number; sampleRate: number; turnId?: number }
  /** The segment's last PCM frame has been sent. Paired with audioBegin: a segment the
   *  pipeline drops emits NEITHER, so never wait on an audioEnd per sentence of text. */
  audioEnd?: number
}

export function mapServerMessage(m: ServerMsg, isPlaying: boolean): MsgEffect {
  const events: VizEvent[] = []
  if (m.type === 'chunk') return { messageFrame: m as unknown as AgentMessageFrame, events }
  if (m.type === 'user-message') {
    const frame = m as unknown as Extract<AgentMessageFrame, { type: 'user-message' }>
    const chars = frame.message.parts.filter(p => p.type === 'text').reduce((n, p) => n + (p as { text: string }).text.length, 0)
    return { messageFrame: frame, events: [{ type: 'sttFinal', chars }] }
  }
  if (m.type === 'error') {
    return { error: m.message || 'Voice error', events: [{ type: 'error' }] }
  }
  // Audio framing. `segmentId` restarts at 0 each turn, so it identifies a segment
  // only WITHIN a turn — never key persistent state on it across turns.
  if (m.type === 'audio-begin') {
    return { audioBegin: { segmentId: m.segmentId as number, sampleRate: m.sampleRate as number, turnId: m.turnId }, events }
  }
  if (m.type === 'audio-end') {
    return { audioEnd: m.segmentId as number, events }
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
  // Sent once, when the first turn of a new thread creates the conversation row.
  if (m.type === 'conversation' && m.conversationId) {
    return { conversation: { id: m.conversationId, title: m.title ?? null }, events }
  }
  return { events }
}
