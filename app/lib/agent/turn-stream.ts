// Client side of the message protocol: one readUIMessageStream per turn, fed by the WS
// `chunk` frames of that turn. Turn ids are monotonic per socket, so "stale" is simply
// "older than the newest turn seen" or "a turn we closed ourselves" (Stop / barge-in).
// Pure (no Vue, no WebSocket) so the ordering rules are unit-testable.
import { readUIMessageStream } from 'ai'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage, AgentUIPart } from '~~/shared/types/agent-ui'

type CloseMeta = { interrupted?: true; errorText?: string }

/** Close out a message whose stream ended: nothing may keep spinning after its turn. */
export function finalizeMessage(m: AgentUIMessage, meta: CloseMeta): AgentUIMessage {
  return {
    ...m,
    metadata: { ...m.metadata, ...meta },
    parts: m.parts.map((p): AgentUIPart => {
      if (p.type === 'dynamic-tool' && (p.state === 'input-streaming' || p.state === 'input-available')) {
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
}

interface ActiveTurn {
  turnId: number
  controller: ReadableStreamDefaultController<AgentUIChunk>
  meta: CloseMeta
  /** Set by discard(): this turn's snapshots belong to a message list that no longer exists. */
  discarded: boolean
  done: Promise<void>
}

export function createClientTurns(o: { upsert: (m: AgentUIMessage) => void }): ClientTurns {
  let current = 0
  const closed = new Set<number>()
  let active: ActiveTurn | null = null
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

  function close(meta: CloseMeta) {
    if (!active) return
    Object.assign(active.meta, meta)
    closed.add(active.turnId)
    try { active.controller.close() } catch { /* already closed */ }
    active = null
  }

  /** Accept a frame's turn (switching to it if newer). False = drop the frame. */
  function advance(turnId: number): boolean {
    if (turnId < current || closed.has(turnId)) return false
    if (turnId > current) {
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
    isStale: turnId => turnId < current || closed.has(turnId),
    // Known window: turn ids are assigned by the SERVER, so with no active turn this closes the
    // newest turn the client has SEEN — not one it has sent but heard nothing from yet. A Stop
    // pressed before turn N's first frame (e.g. while N-1's audio is still playing) therefore
    // lets N's user-message, its already-generated chunks and an audio-begin through
    // (isStale(N) is false). The server still aborts N on the same `interrupt` frame (it aborts
    // whatever turn is current there), so N ends with an `abort` chunk if it produced any — at
    // worst a short "stopped" reply, never a turn that runs on. Closing N here would need its id
    // before any of N's frames arrive, and ids are only ever learned from those frames.
    interrupt() {
      if (active) close({ interrupted: true })
      else if (current) closed.add(current)
    },
    discard() {
      for (const turn of draining) turn.discarded = true
      if (active) close({ interrupted: true })
      else if (current) closed.add(current)
    },
    disconnect() { close({ errorText: 'Connection lost' }) },
    reset() {
      close({ errorText: 'Connection lost' })
      current = 0
      closed.clear()
    },
    settled: () => lastDone
  }
}
