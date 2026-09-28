// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { AgentMessageFrame } from '~~/shared/types/agent-ui'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string; message?: string; requestId?: string; tool?: string; command?: string; proposedPattern?: string; name?: string; summary?: string; undoToken?: string; conversationId?: string; title?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number; segmentId?: number; sampleRate?: number; turnId?: number; epochAt?: string | null; cid?: string }

// Frame types that belong to ONE conversation and must not be applied while viewing a
// different one. Every hub-published JSON frame carries `cid` (server/lib/agent/runtime/
// stream.ts's `withCid`); per-socket frames (approval, steered, cleared, the submit-failure
// error/state pair ws.ts sends straight to the peer) carry none and are never gated. `queued`
// is per-socket too, but ws.ts tags it with its thread by hand — a bubble for a thread we have
// since left must not paint into the one we are viewing.
// `conversation` is gated too: adopting a LEFT thread's id (its first turn persisting in the
// gap before the server processed `new`) would re-point the empty new thread at it — clear
// the left set, arm a re-read that loads it, and drop the real new thread's frames.
// `persisted` is deliberately NOT listed: it only arms a re-read of whatever is viewed.
const CONVERSATION_SCOPED = new Set(['chunk', 'user-message', 'audio-begin', 'state', 'error', 'conversation', 'queued'])

/** What the guard needs to know about the threads `new` walked away from — see
 *  createLeftThreads below. Only consulted while nothing is viewed. */
export interface LeftView {
  readonly ids: ReadonlySet<string>
  /** Whether this socket has submitted a turn (text or voice) since the last `new`. */
  readonly submitted: boolean
}

/**
 * Belt-and-braces alongside the client's turn-id tracking (app/lib/agent/turn-stream.ts): a
 * conversation-scoped frame whose `cid` is for a thread this socket is not viewing is a
 * straggler from a thread we switched away from — drop it outright, independent of whatever
 * the turn-id bookkeeping decides, so it can never render as a ghost message, flip `busy`,
 * raise a stray alert, or re-point the view in the thread we switched TO.
 *
 * - Viewing a thread: drop any cid that differs from it.
 * - Viewing nothing (a brand-new thread, whose id arrives with the `conversation` frame after
 *   its first turn persists): until this socket submits, the new thread has no frames at all,
 *   so EVERY tagged frame is from a thread we left — including one whose id we never learned
 *   (`new` clicked before its first frame arrived). After the submit, the new thread's own
 *   frames carry an id we cannot know yet and must pass; drop only the cids known to be left.
 *   (reset() on `new` has cleared the turn-id layer's `discarded` set and zeroed `current`,
 *   so nothing below this guard would catch them.)
 */
function isForeignFrame(m: ServerMsg, viewed: string | null, left: LeftView): boolean {
  if (m.cid === undefined || !CONVERSATION_SCOPED.has(m.type)) return false
  if (viewed !== null) return m.cid !== viewed
  return !left.submitted || left.ids.has(m.cid)
}
// Default for callers that don't track left threads (mostly tests): lets everything through
// while nothing is viewed, as before this guard existed.
const NOTHING_LEFT: LeftView = { ids: new Set(), submitted: true }

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
  /** This socket's text was queued as its own run BEHIND the thread's running run (a headless
   *  wake, typically). Painted as an optimistic bubble like `steered`; unlike a steer, its run
   *  later sends its own `user-message`, which replaces the bubble (see queuedEchoIndex). */
  queued?: string
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
 * `left` is what `new` walked away from since a thread was last viewed (useVoice's `left`, a
 * createLeftThreads()) — only consulted while `viewedConversationId` is null; see the guard
 * above.
 */
export function mapServerMessage(
  m: ServerMsg,
  isPlaying: boolean,
  viewedConversationId: string | null = null,
  left: LeftView = NOTHING_LEFT
): MsgEffect {
  if (isForeignFrame(m, viewedConversationId, left)) return {}
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
  // Queued behind the running run — see MsgEffect.queued.
  if (m.type === 'queued' && typeof m.text === 'string') {
    return { queued: m.text }
  }
  return {}
}

/** Id prefix of the optimistic bubble painted for a `queued` frame (never a server row id). */
export const QUEUED_ID_PREFIX = 'queued-'

interface BubbleLike { id: string, role: string, parts?: readonly { type: string, text?: string }[] }
const bubbleText = (m: BubbleLike) => (m.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('')

/**
 * Where, if anywhere, the optimistic bubble of a queued message sits once that message's run
 * starts and sends its own `user-message`. The caller removes it before upserting the real one:
 * left in place, the question shows twice while the run streams, and the post-turn re-read then
 * REFUSES the (shorter) server list, stranding the turn on stream ids. A steer bubble never
 * matches — a steer gets no user-message of its own; the re-read replaces it.
 */
export function queuedEchoIndex(list: readonly BubbleLike[], incoming: BubbleLike): number {
  if (incoming.role !== 'user') return -1
  const text = bubbleText(incoming)
  return list.findIndex(m => m.role === 'user' && m.id.startsWith(QUEUED_ID_PREFIX) && bubbleText(m) === text)
}

/**
 * The threads `new` walked away from while nothing is viewed yet — the `left` view
 * mapServerMessage's cid guard needs. useVoice owns one; pure so the lifecycle is testable.
 *
 * `new` leaves either a thread with a known id, or an id-less brand-new one whose first turn
 * is still running: the client only learns that thread's id from the `conversation` frame
 * sent AFTER the turn persists. Its frames already carry the id as `cid`, though, so
 * `observe()` learns it from them — both before `new` (the latest cid seen while viewing
 * nothing) and after it (any tagged frame arriving before this socket's next submit can only
 * be from a left thread). The `submitted` flag covers the frame that arrives before either.
 */
export interface LeftThreads extends LeftView {
  /** Every server JSON frame, BEFORE mapping it. */
  observe(m: ServerMsg, viewedConversationId: string | null): void
  /** This socket sent a turn (text or voice): the id-less view now has frames of its own. */
  submit(): void
  /** newConversation(): the thread being left (its id, or the one observed) joins `ids`, and
   *  nothing is submitted on the new thread yet. */
  leave(viewedConversationId: string | null): void
  /** A thread is viewed again (the `conversation` frame adopted, or a resume) — the plain
   *  mismatch check owns every cid from here on. */
  clear(): void
}

export function createLeftThreads(): LeftThreads {
  const ids = new Set<string>()
  let unnamed: string | null = null
  // Starts false: a fresh socket viewing nothing has submitted nothing, so no frame is ours.
  let submitted = false
  return {
    ids,
    get submitted() { return submitted },
    observe(m, viewed) {
      if (viewed !== null || m.cid === undefined) return
      // Before our first submit, nothing tagged can be the new thread's — remember it as left
      // so it stays dropped even after the submit. After it, the latest cid names the id-less
      // thread being viewed (a left straggler recorded here is harmless: leave() would only
      // re-add an id already in `ids`, and the thread's own frames overwrite it).
      if (!submitted) ids.add(m.cid)
      else unnamed = m.cid
    },
    submit() { submitted = true },
    leave(viewed) {
      const id = viewed ?? unnamed
      if (id) ids.add(id)
      unnamed = null
      submitted = false
    },
    clear() {
      ids.clear()
      unnamed = null
    }
  }
}
