// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { AgentMessageFrame } from '~~/shared/types/agent-ui'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string; message?: string; requestId?: string; tool?: string; command?: string; proposedPattern?: string; name?: string; summary?: string; undoToken?: string; conversationId?: string; title?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number; segmentId?: number; sampleRate?: number; turnId?: number; epochAt?: string | null; cid?: string }

// Frame types that belong to ONE conversation's turn and must not be applied while viewing a
// different one. Every hub-published JSON frame carries `cid` (server/lib/agent/runtime/
// stream.ts's `withCid`); per-socket frames (approval, steered, cleared, the submit-failure
// error/state pair ws.ts sends straight to the peer) carry none and are never gated.
// `conversation` and `persisted` are hub-published but deliberately NOT listed: the first is
// how a brand-new thread learns its id (its cid IS the new thread's), the second only arms a
// re-read of whatever is viewed.
const CONVERSATION_SCOPED = new Set(['chunk', 'user-message', 'audio-begin', 'state', 'error'])

/**
 * Belt-and-braces alongside the client's turn-id tracking (app/lib/agent/turn-stream.ts): a
 * conversation-scoped frame whose `cid` is for a thread this socket is not viewing is a
 * straggler from a thread we switched away from — drop it outright, independent of whatever
 * the turn-id bookkeeping decides, so it can never render as a ghost message, flip `busy`, or
 * raise a stray alert in the thread we switched TO.
 *
 * - Viewing a thread: drop any cid that differs from it.
 * - Viewing nothing (a brand-new thread, whose id arrives with the `conversation` frame after
 *   its first turn persists): the new thread's own frames carry an id we cannot know yet, so
 *   they must pass — but the threads `new` LEFT are known (`left`), and a still-running turn
 *   there (or its next queued one) keeps publishing until the server processes `new`. Drop
 *   exactly those cids. (reset() on `new` has cleared the turn-id layer's `discarded` set and
 *   zeroed `current`, so nothing below this guard would catch them.)
 */
function isForeignFrame(m: ServerMsg, viewed: string | null, left: ReadonlySet<string>): boolean {
  if (m.cid === undefined || !CONVERSATION_SCOPED.has(m.type)) return false
  if (viewed !== null) return m.cid !== viewed
  return left.has(m.cid)
}
const NO_IDS: ReadonlySet<string> = new Set()

export interface MsgEffect {
  // 'listening'/'connecting' never come from the server (client VAD / WS dial own them).
  state?: 'idle' | 'thinking' | 'speaking' | 'tool' | 'typing'
  /** A `chunk` or `user-message` frame — handed to lib/agent/turn-stream.ts as-is. */
  messageFrame?: AgentMessageFrame
  error?: string
  approval?: { requestId: string; tool: string; command: string; proposedPattern: string }
  approvalResolved?: string // requestId that was settled server-side (timeout)
  /** The server lazily created a thread on this turn — id + its derived title. */
  conversation?: { id: string; title: string | null }
  /** This turn's rows are COMMITTED, and this is the thread they landed in. Sent immediately
   *  after `appendMessages` returns (server/api/voice/ws.ts), on every turn — the only
   *  post-commit signal the page has. `state:'idle'` is emitted inside the orchestrator's exec,
   *  before the append, so a re-read armed by idle alone races the persist. */
  persisted?: string
  /** `/clear`'s boundary (server/services/conversation-clear.ts). `epochAt` is the ISO
   *  timestamp the model now reads history FROM — null means there was nothing to clear
   *  (no conversation yet), which is a no-op, not a failure. */
  cleared?: { epochAt: string | null }
  /** This socket's text was spliced into the thread's already-running turn instead of
   *  queuing a new one (server/api/voice/ws.ts's `submit`). The caller renders an optimistic
   *  user bubble for it; the post-turn re-read (armed by `persisted`) replaces it with the
   *  real row. */
  steered?: string
  /** A spoken segment is starting: the binary frames that follow are headerless PCM
   *  (mono / s16le) at THIS sample rate — the client cannot decode them without it.
   *  `turnId` names which turn opened it, so a segment from a superseded turn can be
   *  rejected outright (see useVoice's onAudioBegin / turns.isStale). */
  audioBegin?: { segmentId: number; sampleRate: number; turnId?: number }
  /** The segment's last PCM frame has been sent. Paired with audioBegin: a segment the
   *  pipeline drops emits NEITHER, so never wait on an audioEnd per sentence of text. */
  audioEnd?: number
}

/**
 * `viewedConversationId` is the thread this socket currently views (useVoice's
 * `conversationId.value`) — default `null` only for callers (mostly tests) that don't care
 * about the cid guard below; every real caller (useVoice's onmessage) passes the live value.
 * `leftConversationIds` are the threads `new` walked away from since a thread was last viewed
 * (useVoice's `leftCids`) — only consulted while `viewedConversationId` is null; see the
 * guard below.
 */
export function mapServerMessage(
  m: ServerMsg,
  isPlaying: boolean,
  viewedConversationId: string | null = null,
  leftConversationIds: ReadonlySet<string> = NO_IDS
): MsgEffect {
  if (isForeignFrame(m, viewedConversationId, leftConversationIds)) return {}
  if (m.type === 'chunk') return { messageFrame: m as unknown as AgentMessageFrame }
  if (m.type === 'user-message') {
    const frame = m as unknown as Extract<AgentMessageFrame, { type: 'user-message' }>
    return { messageFrame: frame }
  }
  if (m.type === 'error') {
    return { error: m.message || 'Voice error' }
  }
  // Audio framing. `segmentId` restarts at 0 each turn, so it identifies a segment
  // only WITHIN a turn — never key persistent state on it across turns.
  if (m.type === 'audio-begin') {
    return { audioBegin: { segmentId: m.segmentId as number, sampleRate: m.sampleRate as number, turnId: m.turnId } }
  }
  if (m.type === 'audio-end') {
    return { audioEnd: m.segmentId as number }
  }
  if (m.type === 'state') {
    if (m.state === 'speaking') return { state: 'speaking' }
    if (m.state === 'thinking') return { state: 'thinking' }
    if (m.state === 'tool') return { state: 'tool' }
    if (m.state === 'typing') return { state: 'typing' }
    // Server says idle the moment generation ends, but audio may still be
    // buffered ahead — playback drain flips to idle in that case (useVoice).
    return isPlaying ? {} : { state: 'idle' }
  }
  if (m.type === 'approval' && m.requestId && m.command) {
    return { approval: { requestId: m.requestId, tool: m.tool ?? 'exec', command: m.command, proposedPattern: m.proposedPattern ?? '' } }
  }
  if (m.type === 'approval-resolved' && m.requestId) {
    return { approvalResolved: m.requestId }
  }
  // Sent once, when the first turn of a new thread creates the conversation row.
  if (m.type === 'conversation' && m.conversationId) {
    return { conversation: { id: m.conversationId, title: m.title ?? null } }
  }
  // Sent after EVERY turn's rows are committed — see MsgEffect.persisted.
  if (m.type === 'persisted' && m.conversationId) {
    return { persisted: m.conversationId }
  }
  // `/clear`'s boundary — see MsgEffect.cleared.
  if (m.type === 'cleared') {
    return { cleared: { epochAt: m.epochAt ?? null } }
  }
  // Steered into the running turn instead of queued — see MsgEffect.steered.
  if (m.type === 'steered' && typeof m.text === 'string') {
    return { steered: m.text }
  }
  return {}
}

/**
 * The threads `new` walked away from while nothing is viewed yet — the `leftConversationIds`
 * mapServerMessage's cid guard needs. useVoice owns one; pure so the lifecycle is testable.
 *
 * `new` leaves either a thread with a known id, or an id-less brand-new one whose first turn
 * is still running: the client only learns that thread's id from the `conversation` frame
 * sent AFTER the turn persists. Its frames already carry the id as `cid`, though, so
 * `observe()` remembers it from them — leaving such a thread mid-first-turn (the most common
 * way to abandon a long reply) must drop its stragglers too, not just a named thread's.
 */
export interface LeftThreads {
  readonly ids: ReadonlySet<string>
  /** Every server JSON frame, BEFORE mapping it. While viewing nothing, the latest tagged
   *  frame names the id-less thread being viewed — remember its id. */
  observe(m: ServerMsg, viewedConversationId: string | null): void
  /** newConversation(): the thread being left (its id, or the one observed) joins `ids`. */
  leave(viewedConversationId: string | null): void
  /** A thread is viewed again (the `conversation` frame adopted, or a resume) — the plain
   *  mismatch check owns every cid from here on. */
  clear(): void
}

export function createLeftThreads(): LeftThreads {
  const ids = new Set<string>()
  let unnamed: string | null = null
  return {
    ids,
    observe(m, viewed) {
      // A left thread's straggler lands here too; recording it is harmless (leave() would
      // only re-add an id already in `ids`), and the new thread's own frames overwrite it.
      if (viewed === null && m.cid !== undefined) unnamed = m.cid
    },
    leave(viewed) {
      const id = viewed ?? unnamed
      if (id) ids.add(id)
      unnamed = null
    },
    clear() {
      ids.clear()
      unnamed = null
    }
  }
}
