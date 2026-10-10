import { describe, it, expect, vi, afterEach } from 'vitest'
import { createClientTurns, finalizeMessage } from './turn-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '@mymind/core/shared/types/agent-ui'

function harness() {
  const messages: AgentUIMessage[] = []
  const turns = createClientTurns({
    upsert: (m) => {
      const i = messages.findIndex(x => x.id === m.id)
      if (i >= 0) messages[i] = m
      else messages.push(m)
    }
  })
  const chunk = (turnId: number, c: AgentUIChunk) => turns.handle({ type: 'chunk', turnId, chunk: c })
  const user = (turnId: number, id: string, text: string) =>
    turns.handle({ type: 'user-message', turnId, message: { id, role: 'user', parts: [{ type: 'text', text }] } } as AgentMessageFrame)
  const begin = (turnId: number, id: string) => { chunk(turnId, { type: 'start', messageId: id }); chunk(turnId, { type: 'text-start', id: `${id}-t` }) }
  const say = (turnId: number, id: string, t: string) => chunk(turnId, { type: 'text-delta', id: `${id}-t`, delta: t })
  const end = (turnId: number, id: string) => { chunk(turnId, { type: 'text-end', id: `${id}-t` }); chunk(turnId, { type: 'finish' }) }
  const textOf = (id: string) => messages.find(m => m.id === id)?.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
  return { messages, turns, chunk, user, begin, say, end, textOf }
}

describe('createClientTurns', () => {
  it('upserts the user message and assembles the assistant message', async () => {
    const h = harness()
    h.user(1, 'u1', 'hi'); h.begin(1, 'a1'); h.say(1, 'a1', 'Hel'); h.say(1, 'a1', 'lo'); h.end(1, 'a1')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    expect(h.textOf('a1')).toBe('Hello')
    expect(h.messages[1]!.parts.find(p => p.type === 'text')).toMatchObject({ state: 'done' })
  })

  it('drops frames from an older turn', async () => {
    const h = harness()
    h.user(2, 'u2', 'second')
    h.begin(1, 'old'); h.say(1, 'old', 'stale'); h.end(1, 'old')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u2'])
  })

  it('a newer turn supersedes the active one: interrupted, dangling tool stopped', async () => {
    const h = harness()
    h.user(1, 'u1', 'go'); h.chunk(1, { type: 'start', messageId: 'a1' })
    h.chunk(1, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_fetch', input: {}, dynamic: true })
    await new Promise(r => setTimeout(r, 0))
    h.user(2, 'u2', 'never mind')
    await h.turns.settled()
    const a1 = h.messages.find(m => m.id === 'a1')!
    expect(a1.metadata?.interrupted).toBe(true)
    expect(a1.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
    expect(h.messages.at(-1)!.id).toBe('u2')
  })

  it('interrupt() closes the turn and ignores its later frames', async () => {
    const h = harness()
    h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'par')
    h.turns.interrupt()
    h.say(1, 'a1', 'tial')
    await h.turns.settled()
    expect(h.textOf('a1')).toBe('par')
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.interrupted).toBe(true)
  })

  it('interrupt() before any chunk still drops that turn', async () => {
    const h = harness()
    h.user(1, 'u1', 'go')
    h.turns.interrupt()
    h.begin(1, 'a1'); h.say(1, 'a1', 'late'); h.end(1, 'a1')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u1'])
  })

  it('an error chunk keeps the partial text and records errorText', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'partial')
    h.chunk(1, { type: 'text-end', id: 'a1-t' }); h.chunk(1, { type: 'error', errorText: 'boom' })
    await h.turns.settled()
    const a1 = h.messages.find(m => m.id === 'a1')!
    expect(h.textOf('a1')).toBe('partial')
    expect(a1.metadata?.errorText).toBe('boom')
  })

  it('an abort chunk marks the message interrupted', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'x'); h.chunk(1, { type: 'abort' })
    await h.turns.settled()
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.interrupted).toBe(true)
  })

  it('disconnect() closes the active turn as Connection lost', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'x')
    h.turns.disconnect()
    await h.turns.settled()
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.errorText).toBe('Connection lost')
  })

  it('reset() restarts turn numbering for a new socket', async () => {
    const h = harness()
    h.user(3, 'u3', 'before reconnect')
    h.turns.reset()
    h.user(1, 'u1b', 'after reconnect')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u3', 'u1b'])
  })

  // The resume/attach bug this pins: turn ids are ONE counter shared across every
  // conversation, so chatting on a side thread (turn 100) and then resuming a thread where an
  // OLDER run is still streaming (turn 45 — started earlier in wall-clock time, on a
  // DIFFERENT conversation) must not have that lower id read as "stale" and dropped.
  it('reset() makes a turn id LOWER than the pre-reset current acceptable again (resuming a thread with an older running turn)', async () => {
    const h = harness()
    h.user(100, 'side-u', 'chatting on a side thread')
    expect(h.turns.isStale(45)).toBe(true) // true before reset — 45 < 100
    h.turns.reset()
    h.begin(45, 'wake-a')
    expect(h.turns.isStale(45)).toBe(false) // accepted, not dropped as "older than 100"
    h.say(45, 'wake-a', 'still going'); h.end(45, 'wake-a')
    await h.turns.settled()
    expect(h.textOf('wake-a')).toBe('still going')
  })

  // Round 2's finding: discard()-then-reset() is not, on its own, a defense against a
  // cross-thread straggler ANY MORE — that protection now lives one layer up, in the cid
  // guard (app/lib/voice/messages.ts's mapServerMessage — see its own ghost-scenario test).
  // At THIS layer, discard() only ever marks a turn `discarded` (revocable), never
  // `finished` (permanent) — see the next test for why that split exists and what it buys.
  //
  // Round 3's finding (why the split exists at all): a single permanently-`closed` id (round
  // 2's fix) broke A→B→A — switching away from a thread with a still-running turn and then
  // BACK to it never rendered the replay again, because discard() had permanently closed
  // that exact turn id. Since the cid guard now independently drops a cross-thread
  // straggler, a merely-discarded turn no longer needs to stay closed forever here.
  it('discard() then reset() (switching away) does not permanently block that turn — attaching back to the SAME conversation later replays it (A→B→A)', async () => {
    const h = harness()
    h.begin(45, 'a-thread'); h.say(45, 'a-thread', 'streaming on A')
    await new Promise(r => setTimeout(r, 0))
    // A -> B: mirrors resume()'s discardTurn() then resetTurns(), same synchronous tick.
    h.turns.discard()
    h.turns.reset()
    h.messages.splice(0) // messages.value = next (B's own, unrelated transcript)
    // B -> A: another discard()+reset() (nothing active on B to close), then attach()
    // replays A's still-running turn 45 from the start — the SAME turn id as before.
    h.turns.discard()
    h.turns.reset()
    h.messages.splice(0) // messages.value = next (A's own transcript, replaced again)
    h.begin(45, 'a-thread'); h.say(45, 'a-thread', 'still going on A'); h.end(45, 'a-thread')
    await h.turns.settled()
    expect(h.textOf('a-thread')).toBe('still going on A')
  })

  // `finished` is never cleared by reset() (a turn that genuinely ended can't legitimately
  // reappear — turn ids are one global counter, never reused), so a long-lived tab needs a
  // bound on it or it grows forever. FINISHED_CAP evicts the OLDEST id once past the cap —
  // a deliberate memory/correctness tradeoff: a turn closed hundreds of turns ago becomes
  // acceptable again (extremely unlikely to ever matter), while every recently-closed id
  // stays protected. interrupt()'s no-active-turn fallback marks `finished` (Stop really
  // does end the turn), so it's what this test exercises.
  it('caps `finished` at a bounded size, evicting the oldest id first', () => {
    const h = harness()
    for (let i = 1; i <= 400; i++) { h.user(i, `u${i}`, 'x'); h.turns.interrupt() }
    h.turns.reset() // current -> 0; `finished` itself is untouched by this
    // id 1 fell out of the cap ~300 closes ago — accepted again now that current is 0.
    expect(h.turns.isStale(1)).toBe(false)
    // id 398 is well within the last ~300 and must still be rejected.
    expect(h.turns.isStale(398)).toBe(true)
  })

  describe('shouldAttach()', () => {
    it('approves the first ask for a conversationId', () => {
      const h = harness()
      expect(h.turns.shouldAttach('c1')).toBe(true)
    })

    it('refuses an immediate repeat ask for the SAME conversationId (moveLeaf-style same-thread resume)', () => {
      const h = harness()
      expect(h.turns.shouldAttach('c1')).toBe(true)
      expect(h.turns.shouldAttach('c1')).toBe(false)
      expect(h.turns.shouldAttach('c1')).toBe(false)
    })

    it('approves a DIFFERENT conversationId even right after approving another one', () => {
      const h = harness()
      expect(h.turns.shouldAttach('c1')).toBe(true)
      expect(h.turns.shouldAttach('c2')).toBe(true)
      expect(h.turns.shouldAttach('c1')).toBe(true) // switched back — not "already attached" anymore
    })

    it('reset() forgets the remembered id, so the very same conversationId is approved again', () => {
      const h = harness()
      expect(h.turns.shouldAttach('c1')).toBe(true)
      h.turns.reset()
      expect(h.turns.shouldAttach('c1')).toBe(true)
    })
  })

  // discard(): the page replaced the message list (new thread, resume, retry). The running
  // turn must never write into the NEW list — not even its closing "stopped" snapshot.
  describe('discard()', () => {
    it('suppresses every further upsert of the turn, including the finalize, with chunks already queued', async () => {
      const h = harness()
      h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'queued')
      // Replace the list the way newConversation/resume/retry do, then discard.
      h.messages.splice(0)
      h.turns.discard()
      await h.turns.settled()
      expect(h.messages).toEqual([])
    })

    it('drops later frames of the discarded turn', async () => {
      const h = harness()
      h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'par')
      await new Promise(r => setTimeout(r, 0))
      h.messages.splice(0)
      h.turns.discard()
      h.say(1, 'a1', 'tial'); h.end(1, 'a1')
      h.user(1, 'u1-again', 'late echo')
      await h.turns.settled()
      expect(h.messages).toEqual([])
      expect(h.turns.isStale(1)).toBe(true)
    })

    it('also silences a turn that already finished but is still draining its queued chunks', async () => {
      const h = harness()
      h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'whole reply'); h.end(1, 'a1')
      // `finish` arrived (the turn is closed, no longer active) but the assembler has not
      // yet drained the queue when the page swaps threads.
      h.messages.splice(0)
      h.turns.discard()
      await h.turns.settled()
      expect(h.messages).toEqual([])
    })

    it('drops the turn even before its first chunk', async () => {
      const h = harness()
      h.user(1, 'u1', 'go')
      h.messages.splice(0)
      h.turns.discard()
      h.begin(1, 'a1'); h.say(1, 'a1', 'late'); h.end(1, 'a1')
      await h.turns.settled()
      expect(h.messages).toEqual([])
    })

    it('a newer turn still streams normally after a discard', async () => {
      const h = harness()
      h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'old')
      h.messages.splice(0)
      h.turns.discard()
      h.user(2, 'u2', 'fresh'); h.begin(2, 'a2'); h.say(2, 'a2', 'new'); h.end(2, 'a2')
      await h.turns.settled()
      expect(h.messages.map(m => m.id)).toEqual(['u2', 'a2'])
      expect(h.textOf('a2')).toBe('new')
      expect(h.messages[1]!.metadata?.interrupted).toBeUndefined()
    })

    it('is a no-op on a fresh socket', async () => {
      const h = harness()
      h.turns.discard()
      h.user(1, 'u1', 'first'); h.begin(1, 'a1'); h.say(1, 'a1', 'ok'); h.end(1, 'a1')
      await h.turns.settled()
      expect(h.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    })
  })

  describe('assembler errors', () => {
    afterEach(() => { vi.restoreAllMocks() })

    // A chunk the SDK's assembler rejects (here: a text-delta for a text part that was never
    // started) errors its TransformStream, which cancels this turn's source stream.
    const poison = (h: ReturnType<typeof harness>, turnId: number) =>
      h.chunk(turnId, { type: 'text-delta', id: 'never-started', delta: 'x' })

    it('logs the error with the turn id instead of swallowing it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = harness()
      h.begin(4, 'a4'); h.say(4, 'a4', 'ok so far'); poison(h, 4)
      await h.turns.settled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn 4'), expect.anything())
      expect(h.textOf('a4')).toBe('ok so far')
    })

    it('a later chunk for that turn cannot throw out of handle() (the socket onmessage)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = harness()
      h.begin(5, 'a5'); poison(h, 5)
      await h.turns.settled()
      await new Promise(r => setTimeout(r, 0))
      expect(() => h.say(5, 'a5', 'more')).not.toThrow()
      expect(() => h.end(5, 'a5')).not.toThrow()
    })
  })

  it('isStale reports older and closed turns', () => {
    const h = harness()
    h.user(2, 'u2', 'x')
    expect(h.turns.isStale(1)).toBe(true)
    expect(h.turns.isStale(2)).toBe(false)
    h.turns.interrupt()
    expect(h.turns.isStale(2)).toBe(true)
  })
})

describe('finalizeMessage', () => {
  it('stops everything still in flight and merges the metadata', () => {
    const m: AgentUIMessage = {
      id: 'a', role: 'assistant', metadata: { createdAt: 't' },
      parts: [
        { type: 'reasoning', text: 'r', state: 'streaming' },
        { type: 'text', text: 'x', state: 'streaming' },
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'c', state: 'input-streaming', input: undefined },
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'd', state: 'output-available', input: {}, output: { value: 1, summary: 's' } },
        { type: 'data-subagent', id: 'c', data: { steps: [{ callId: 'n', name: 'w', state: 'running' }] } }
      ]
    }
    const f = finalizeMessage(m, { interrupted: true })
    expect(f.metadata).toEqual({ createdAt: 't', interrupted: true })
    expect(f.parts.map(p => ('state' in p ? p.state : (p as { data: { steps: { state: string }[] } }).data.steps[0]!.state)))
      .toEqual(['done', 'done', 'output-error', 'output-available', 'error'])
    expect(f.parts[2]).toMatchObject({ errorText: 'Stopped' })
  })
  it('a pending approval ends as Stopped', () => {
    const m: AgentUIMessage = { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'exec', toolCallId: 'c', state: 'approval-requested', input: {}, approval: { id: 'r1' } }] }
    expect(finalizeMessage(m, { interrupted: true }).parts[0]).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
  })
})
