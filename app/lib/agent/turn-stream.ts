// Client side of the message protocol: one readUIMessageStream per turn, fed by the WS
// `chunk` frames of that turn. Turn ids are monotonic per socket, so "stale" is simply
// "older than the newest turn seen" or "a turn we closed ourselves" (Stop / barge-in).
// Pure (no Vue, no WebSocket) so the ordering rules are unit-testable.
import { readUIMessageStream } from 'ai'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage, AgentUIPart } from '@mymind/core/shared/types/agent-ui'

type CloseMeta = { interrupted?: true; errorText?: string }

/** Close out a message whose stream ended: nothing may keep spinning after its turn. */
export function finalizeMessage(m: AgentUIMessage, meta: CloseMeta): AgentUIMessage {
  return {
    ...m,
    metadata: { ...m.metadata, ...meta },
    parts: m.parts.map((p): AgentUIPart => {
      if (p.type === 'dynamic-tool' && (p.state === 'input-streaming' || p.state === 'input-available' || p.state === 'approval-requested')) {
        return { type: 'dynamic-tool', toolName: p.toolName, toolCallId: p.toolCallId, state: 'output-error', input: p.input, errorText: 'Stopped' }
      }
      if ((p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming') return { ...p, state: 'done' }
      if (p.type === 'data-subagent') {
        return { ...p, data: { steps: p.data.steps.map(s => (s.state === 'running' ? { ...s, state: 'error' as const } : s)) } }
      }
      return p
    })
  }
}

export interface ClientTurns {
  handle(frame: AgentMessageFrame): void
  isStale(turnId: number): boolean
  interrupt(): void
  /** The page replaced the message list (new thread, resume, retry): close the running turn
   *  and make sure nothing from it — not even its finalize snapshot — is upserted again. */
  discard(): void
  disconnect(): void
  reset(): void
  settled(): Promise<void>
  /**
   * Whether `attach()` should actually (re)subscribe for `conversationId` — true the first
   * time asked (or after `reset()`), false on an immediate repeat for the SAME id. A repeat
   * attach on an unchanged thread would ask the hub to replay the running turn's buffered
   * frames again into the stream that already has them, duplicating its content (the same
   * chunks enqueued twice) rather than being a harmless no-op. Marks the id remembered as a
   * side effect of returning true, so the caller need not track anything itself.
   */
  shouldAttach(conversationId: string): boolean
}

interface ActiveTurn {
  turnId: number
  controller: ReadableStreamDefaultController<AgentUIChunk>
  meta: CloseMeta
  /** Set by discard(): this turn's snapshots belong to a message list that no longer exists.
   *  Per-TURN flag — unrelated to the `discarded` turn-id Set below (same word, two things:
   *  this one gates upserts from the in-flight assembler loop; that one gates advance()). */
  discarded: boolean
  done: Promise<void>
}

// Cap on how many ids `finished` remembers. Real turn ids are a single counter shared across
// every conversation (server-side), never reused — so keeping them all would be correct
// forever, but unbounded for a long-lived tab. A few hundred is far more than any realistic
// straggler-frame delay (network latency between the server processing `load` and whatever
// chunk was already queued before it) could ever need.
const FINISHED_CAP = 300

export function createClientTurns(o: { upsert: (m: AgentUIMessage) => void }): ClientTurns {
  let current = 0
  // Turns that ended for real — a natural finish/abort/error chunk, a Stop, or being
  // superseded by a newer turn on the SAME conversation. The turn is over server-side too
  // (or is about to be, via the interrupt frame), so its id can never legitimately reappear.
  // Permanent (capped for memory) — survives reset().
  const finished = new Set<number>()
  // Turns this client merely STOPPED RENDERING because the page switched away — the turn may
  // still be running server-side. Cleared by reset() on a thread switch: attaching back to
  // the SAME conversation must re-accept its still-running turn's replay, not treat it as
  // permanently dead. While viewing a DIFFERENT conversation, a straggler frame for a
  // discarded turn is caught by the cid guard (app/lib/voice/messages.ts's mapServerMessage)
  // instead — belt and braces, not this set.
  const discarded = new Set<number>()
  // The conversationId shouldAttach() last approved an attach for — see its doc comment.
  let attachedTo: string | null = null
  let active: ActiveTurn | null = null

  function isClosed(turnId: number): boolean {
    return finished.has(turnId) || discarded.has(turnId)
  }
  /** Record a turn id as permanently finished, evicting the oldest entry once past the cap
   *  (Set iteration order is insertion order, so `.values().next()` is always the oldest). */
  function markFinished(turnId: number) {
    finished.add(turnId)
    if (finished.size > FINISHED_CAP) finished.delete(finished.values().next().value!)
  }
  let lastDone: Promise<void> = Promise.resolve()
  // Every turn whose assembler is still running. A turn leaves `active` the moment its
  // closing frame arrives, but its queued chunks (and the finalize) are upserted later —
  // discard() has to reach those too.
  const draining = new Set<ActiveTurn>()

  function open(turnId: number): ActiveTurn {
    let controller!: ReadableStreamDefaultController<AgentUIChunk>
    const stream = new ReadableStream<AgentUIChunk>({ start(c) { controller = c } })
    const turn: ActiveTurn = { turnId, controller, meta: {}, discarded: false, done: Promise.resolve() }
    draining.add(turn)
    turn.done = (async () => {
      let last: AgentUIMessage | undefined
      try {
        // onError: an `error` chunk is reported here, not thrown (the meta already has its
        // text), and so is a chunk the assembler rejects. Log either; what was assembled so far
        // is kept and finalized below. It never closes the socket.
        const onError = (err: unknown) => console.warn(`[agent] turn ${turnId}: message stream error`, err)
        for await (const m of readUIMessageStream<AgentUIMessage>({ stream, onError })) {
          // Keep draining rather than `break`: cancelling readUIMessageStream's output makes
          // the SDK's own later close() throw (an unhandled "already closed" rejection).
          if (turn.discarded) continue
          last = m
          o.upsert(m)
        }
      } catch { /* the assembler rejected the stream — finalize what we have */ }
      if (last && !turn.discarded) o.upsert(finalizeMessage(last, turn.meta))
      draining.delete(turn)
    })()
    lastDone = turn.done
    active = turn
    return turn
  }

  /** `opts.discard`: this turn is only being STOPPED RENDERING (resume() switching threads),
   *  not ended — record it in the revocable `discarded` set instead of the permanent
   *  `finished` one. Omitted (the default) for every genuine ending: natural finish/abort/
   *  error, Stop, or superseded by a newer turn on this same conversation. */
  function close(meta: CloseMeta, opts: { discard?: boolean } = {}) {
    if (!active) return
    Object.assign(active.meta, meta)
    if (opts.discard) discarded.add(active.turnId)
    else markFinished(active.turnId)
    try { active.controller.close() } catch { /* already closed */ }
    active = null
  }

  /** Accept a frame's turn (switching to it if newer). False = drop the frame. */
  function advance(turnId: number): boolean {
    if (turnId < current || isClosed(turnId)) return false
    if (turnId > current) {
      // Superseded by a newer turn on THIS conversation — genuinely over, not a
      // switched-away-from discard, so this stays in `finished`, not `discarded`.
      if (active) close({ interrupted: true })
      current = turnId
    }
    return true
  }

  return {
    handle(frame) {
      if (!advance(frame.turnId)) return
      if (frame.type === 'user-message') { o.upsert(frame.message); return }
      const turn = active?.turnId === frame.turnId ? active : open(frame.turnId)
      const c = frame.chunk
      // A chunk the assembler rejected cancelled this turn's stream; enqueue would then throw
      // inside the socket's onmessage. The failure is already logged — drop the chunk.
      try { turn.controller.enqueue(c) } catch { /* stream cancelled by an assembler error */ }
      if (c.type === 'finish') close({})
      else if (c.type === 'abort') close({ interrupted: true })
      else if (c.type === 'error') close({ errorText: c.errorText })
    },
    isStale: turnId => turnId < current || isClosed(turnId),
    // Known window: turn ids are assigned by the SERVER, so with no active turn this closes the
    // newest turn the client has SEEN — not one it has sent but heard nothing from yet. A Stop
    // pressed before turn N's first frame (e.g. while N-1's audio is still playing) therefore
    // lets N's user-message, its already-generated chunks and an audio-begin through
    // (isStale(N) is false). The server still aborts N on the same `interrupt` frame (it aborts
    // whatever turn is current there), so N ends with an `abort` chunk if it produced any — at
    // worst a short "stopped" reply, never a turn that runs on. Closing N here would need its id
    // before any of N's frames arrive, and ids are only ever learned from those frames.
    // Stop genuinely ends the turn (the interrupt frame aborts it server-side too) — `finished`,
    // permanent, same as a natural abort/error/finish.
    interrupt() {
      if (active) close({ interrupted: true })
      else if (current) markFinished(current)
    },
    discard() {
      for (const turn of draining) turn.discarded = true
      // Only STOPPED RENDERING, not ended — the turn may still be running server-side and
      // this socket may attach() back to the SAME conversation later, at which point its
      // replay must be accepted again. `discarded`, not `finished` — see that set's doc
      // comment, and reset()'s below.
      if (active) close({ interrupted: true }, { discard: true })
      else if (current) discarded.add(current)
    },
    disconnect() { close({ errorText: 'Connection lost' }) },
    reset() {
      // No preceding discard() (the raw reconnect path — connectInner's onopen calls this
      // directly): whatever was active is genuinely gone with the old connection, not merely
      // unwatched — `finished`, not `discarded`. When a discard() DID run first (resume()/
      // newConversation(), same synchronous tick), `active` is already null here, so this is
      // a no-op regardless of which set it would have used.
      close({ errorText: 'Connection lost' })
      current = 0
      discarded.clear()
      // `discarded` is cleared on every real thread switch — attaching back to a
      // conversation whose turn we merely stopped rendering must re-accept its replay, not
      // treat it as permanently dead. `finished` is NOT cleared: a turn that genuinely ended
      // can never legitimately reappear (turn ids are one counter shared across every
      // conversation, never reused), so keeping it protects against a straggler chunk for
      // that exact id arriving after this reset — already in flight over the wire before the
      // server processed `load` and unsubscribed this socket. Belt and braces alongside the
      // server tagging every chunk/user-message/audio-begin frame with its conversationId
      // (server/lib/agent/runtime/stream.ts's `withCid`) — a straggler for a DISCARDED (not
      // finished) turn on the thread we've switched AWAY from is caught by that cid guard
      // (app/lib/voice/messages.ts's mapServerMessage) instead of by this set.
      // A reconnect (or a resume onto a different thread — see useVoice's resetTurns) means
      // whatever this socket was subscribed to no longer holds: the next attach() for ANY
      // conversationId, including one it already approved before, must be allowed to fire.
      attachedTo = null
    },
    settled: () => lastDone,
    shouldAttach(conversationId) {
      if (attachedTo === conversationId) return false
      attachedTo = conversationId
      return true
    }
  }
}
