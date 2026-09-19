import { describe, it, expect } from 'vitest'
import { createClientTurns, finalizeMessage } from './turn-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '~~/shared/types/agent-ui'

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
})
