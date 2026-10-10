// In-process fan-out for a conversation's running turn. A run with ZERO subscribers still
// completes and persists — sockets are viewers, not owners. JSON frames of the active run are
// buffered so a socket that opens the thread mid-run (another tab, a second device, a reload)
// can replay the turn so far: the client's turn-stream rejects a text-delta whose message
// never started, so a late joiner without replay would see a poisoned stream.
export interface Sink { id: string; send(data: string | Uint8Array): void }

export class StreamHub {
  private subs = new Map<string, Map<string, Sink>>()
  private buffers = new Map<string, string[]>()
  private sinkCounts = new Map<string, number>()

  subscribe(conversationId: string, sink: Sink, opts: { replay?: boolean } = {}): () => void {
    let m = this.subs.get(conversationId)
    if (!m) this.subs.set(conversationId, m = new Map())
    if (!m.has(sink.id)) this.sinkCounts.set(sink.id, (this.sinkCounts.get(sink.id) ?? 0) + 1)
    m.set(sink.id, sink)
    if (opts.replay) this.replay(conversationId, sink)
    return () => {
      const cur = this.subs.get(conversationId)
      if (!cur?.delete(sink.id)) return
      const n = (this.sinkCounts.get(sink.id) ?? 1) - 1
      if (n <= 0) this.sinkCounts.delete(sink.id); else this.sinkCounts.set(sink.id, n)
      if (!cur.size) this.subs.delete(conversationId)
    }
  }

  replay(conversationId: string, sink: Sink): void {
    for (const f of this.buffers.get(conversationId) ?? []) this.safeSend(sink, f)
  }

  beginRun(conversationId: string): void { this.buffers.set(conversationId, []) }
  endRun(conversationId: string): void { this.buffers.delete(conversationId) }
  hasSink(sinkId: string): boolean { return (this.sinkCounts.get(sinkId) ?? 0) > 0 }

  publish(conversationId: string, data: string | Uint8Array, opts: { only?: string } = {}): void {
    if (!opts.only && typeof data === 'string') this.buffers.get(conversationId)?.push(data)
    const m = this.subs.get(conversationId)
    if (!m) return
    if (opts.only) { const s = m.get(opts.only); if (s) this.safeSend(s, data); return }
    for (const s of m.values()) this.safeSend(s, data)
  }

  private safeSend(s: Sink, d: string | Uint8Array) {
    try { s.send(d) } catch { /* a closed socket must never break the run or other sinks */ }
  }
}

export const hub = new StreamHub()

/**
 * Wrap a sink so every JSON string frame sent through it is tagged with `conversationId` — a
 * cheap splice right after the leading `{` (`{"cid":"<id>",…rest of the frame…}`). Binary
 * frames (raw PCM audio) pass through untouched; they're already gated by their own tagged
 * `audio-begin` frame, so tagging the audio bytes themselves would be redundant work for no
 * benefit.
 *
 * Belt-and-braces alongside the client's turn-id tracking (app/lib/agent/turn-stream.ts): a
 * frame the client's turn bookkeeping accepts by mistake — a bookkeeping bug, a timing edge
 * case neither side anticipated — is still identifiable, and droppable, by conversationId
 * alone (app/lib/voice/messages.ts's `mapServerMessage`).
 *
 * Keeps the WRAPPED sink's `id` verbatim: `StreamHub.hasSink`/subscriber-counting and
 * `publish`'s `only:` targeting are keyed by sink id, and one physical socket subscribes to a
 * DIFFERENT conversationId (a fresh `withCid` wrapper) every time it switches threads — they
 * must all still count as the same peer.
 */
export function withCid(conversationId: string, sink: Sink): Sink {
  return {
    id: sink.id,
    send: (d) => {
      if (typeof d === 'string' && d.startsWith('{')) sink.send(`{"cid":${JSON.stringify(conversationId)},${d.slice(1)}`)
      else sink.send(d)
    }
  }
}
