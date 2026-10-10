// End-to-end over the two client layers useVoice's onmessage composes — mapServerMessage's cid
// guard, then createClientTurns — for the `new` transition: newConversation() runs
// discard() → reset() → conversationId = null and remembers the thread it left
// (createLeftThreads, the same tracker useVoice owns).
// reset() clears `discarded` and zeroes `current`, so the turn-id layer alone ACCEPTS a
// straggler of the abandoned thread's still-running turn; only the leftCid check stops it.
import { describe, it, expect } from 'vitest'
import { createLeftThreads, mapServerMessage, type ServerMsg } from './messages'
import { createClientTurns } from '../agent/turn-stream'
import type { AgentUIChunk, AgentUIMessage } from '@mymind/core/shared/types/agent-ui'

function client() {
  const messages: AgentUIMessage[] = []
  const turns = createClientTurns({
    upsert: (m) => {
      const i = messages.findIndex(x => x.id === m.id)
      if (i >= 0) messages[i] = m
      else messages.push(m)
    }
  })
  const left = createLeftThreads()
  const view = { conversationId: null as string | null, state: 'idle' as string, error: null as string | null }
  // Mirrors useVoice's onmessage for the fields this test cares about.
  function receive(m: { type: string } & Record<string, unknown>) {
    left.observe(m as ServerMsg, view.conversationId)
    const fx = mapServerMessage(m as ServerMsg, false, view.conversationId, left)
    if (fx.messageFrame) turns.handle(fx.messageFrame)
    if (fx.state) view.state = fx.state
    if (fx.error) view.error = fx.error
    if (fx.conversation) { view.conversationId = fx.conversation.id; left.clear() }
  }
  // Mirrors useVoice's newConversation().
  function newConversation() {
    turns.discard()
    turns.reset()
    messages.splice(0)
    left.leave(view.conversationId)
    view.conversationId = null
    view.state = 'idle' // restAfterAbort()
  }
  // Mirrors useVoice's sendText / onSpeechEnd (the frame send itself is the server's job here).
  const submit = () => left.submit()
  // Mirrors resume(): discardTurn() → resetTurns() (which clears `left`) → commit the id.
  function resume(id: string) {
    turns.discard()
    turns.reset()
    left.clear()
    messages.splice(0)
    view.conversationId = id
  }
  const chunk = (cid: string, turnId: number, c: AgentUIChunk) => receive({ type: 'chunk', cid, turnId, chunk: c })
  const user = (cid: string, turnId: number, id: string, text: string) =>
    receive({ type: 'user-message', cid, turnId, message: { id, role: 'user', parts: [{ type: 'text', text }] } })
  return { messages, turns, view, left, receive, newConversation, submit, resume, chunk, user }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('after `new`, the abandoned thread\'s frames never render in the empty new thread', () => {
  it('a straggler of A\'s still-running turn arriving at a part/step boundary renders nothing', async () => {
    const c = client()
    c.view.conversationId = 'A'
    c.user('A', 45, 'ua', 'long question')
    c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    c.chunk('A', 45, { type: 'text-start', id: 't1' })
    c.chunk('A', 45, { type: 'text-delta', id: 't1', delta: 'first part' })
    c.chunk('A', 45, { type: 'text-end', id: 't1' })
    await tick()
    c.newConversation()
    // In flight before the server processed `new`: a step boundary, then a new text part.
    c.chunk('A', 45, { type: 'finish-step' })
    c.chunk('A', 45, { type: 'start-step' })
    c.chunk('A', 45, { type: 'text-start', id: 't2' })
    c.chunk('A', 45, { type: 'text-delta', id: 't2', delta: 'GHOST' })
    c.receive({ type: 'state', state: 'thinking', cid: 'A' })
    // Not turns.settled(): a straggler that got through opens a turn that never finishes, so
    // settled() would hang — a few ticks let any accepted chunk reach the upsert instead.
    for (let i = 0; i < 5; i++) await tick()
    expect(c.messages).toEqual([])
    expect(c.view.state).toBe('idle') // composer not stuck busy
  })

  it('A\'s NEXT queued turn (user-message + start) after `new` renders nothing', async () => {
    const c = client()
    c.view.conversationId = 'A'
    c.user('A', 45, 'ua', 'q'); c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    await tick()
    c.newConversation()
    c.user('A', 46, 'ua2', 'queued follow-up')
    c.chunk('A', 46, { type: 'start', messageId: 'a46' })
    c.chunk('A', 46, { type: 'text-start', id: 't' })
    c.chunk('A', 46, { type: 'text-delta', id: 't', delta: 'GHOST' })
    c.receive({ type: 'error', message: 'A failed', cid: 'A' })
    // Not turns.settled(): a straggler that got through opens a turn that never finishes, so
    // settled() would hang — a few ticks let any accepted chunk reach the upsert instead.
    for (let i = 0; i < 5; i++) await tick()
    expect(c.messages).toEqual([])
    expect(c.view.error).toBeNull()
  })

  it('a genuine first turn on the new thread still renders, and its `conversation` frame is adopted', async () => {
    const c = client()
    c.view.conversationId = 'A'
    c.user('A', 45, 'ua', 'q'); c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    await tick()
    c.newConversation()
    c.submit()
    c.receive({ type: 'state', state: 'thinking', cid: 'N' })
    expect(c.view.state).toBe('thinking')
    c.user('N', 47, 'un', 'hello new')
    c.chunk('N', 47, { type: 'start', messageId: 'an' })
    c.chunk('N', 47, { type: 'text-start', id: 't' })
    c.chunk('N', 47, { type: 'text-delta', id: 't', delta: 'hi there' })
    c.chunk('N', 47, { type: 'text-end', id: 't' })
    c.chunk('N', 47, { type: 'finish' })
    c.receive({ type: 'conversation', conversationId: 'N', title: 'New', cid: 'N' })
    await c.turns.settled()
    expect(c.messages.map(m => m.id)).toEqual(['un', 'an'])
    expect(c.view.conversationId).toBe('N')
    expect(c.left.ids.size).toBe(0)
  })

  // The commonest abandon: a brand-new thread's FIRST turn is still streaming, so the client
  // has no id for it yet (the `conversation` frame only follows the persist) — only the cid
  // on its frames names it. `new` must still recognise that thread's stragglers.
  it('leaving an id-less thread mid-first-turn drops its stragglers too (id learned from cid)', async () => {
    const c = client() // viewing nothing: a fresh page / fresh New conversation
    c.submit()
    c.user('A', 45, 'ua', 'long question')
    c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    c.chunk('A', 45, { type: 'text-start', id: 't1' })
    c.chunk('A', 45, { type: 'text-delta', id: 't1', delta: 'first part' })
    await tick()
    expect(c.messages.map(m => m.id)).toEqual(['ua', 'a45']) // A's own frames render on A
    c.newConversation()
    c.chunk('A', 45, { type: 'text-end', id: 't1' })
    c.chunk('A', 45, { type: 'finish-step' })
    c.chunk('A', 45, { type: 'start-step' })
    c.chunk('A', 45, { type: 'text-start', id: 't2' })
    c.chunk('A', 45, { type: 'text-delta', id: 't2', delta: 'GHOST' })
    c.receive({ type: 'state', state: 'thinking', cid: 'A' })
    for (let i = 0; i < 5; i++) await tick()
    expect(c.messages).toEqual([])
    expect(c.view.state).toBe('idle')
    // ...and a genuine first turn on the NEXT new thread still renders.
    c.submit()
    c.chunk('A', 45, { type: 'text-delta', id: 't2', delta: 'LATE GHOST' }) // still dropped
    c.user('N', 47, 'un', 'hello'); c.chunk('N', 47, { type: 'start', messageId: 'an' })
    c.chunk('N', 47, { type: 'finish' })
    await c.turns.settled()
    expect(c.messages.map(m => m.id)).toEqual(['un', 'an'])
  })

  it('two `new`s in a row keep BOTH left threads dropped', async () => {
    const c = client()
    c.view.conversationId = 'A'
    c.newConversation() // leaves A
    c.submit()
    c.user('B', 46, 'ub', 'q'); c.chunk('B', 46, { type: 'start', messageId: 'b46' })
    await tick()
    c.newConversation() // leaves id-less B
    c.submit() // typed straight away in the next new thread
    c.chunk('A', 45, { type: 'start', messageId: 'ghost-a' })
    c.chunk('B', 46, { type: 'text-start', id: 't' })
    c.chunk('B', 46, { type: 'text-delta', id: 't', delta: 'GHOST' })
    c.user('B', 48, 'ub2', 'queued')
    for (let i = 0; i < 5; i++) await tick()
    expect(c.messages).toEqual([])
  })

  // Round 5, finding 2 (the reviewer's probe): New clicked before ANY frame of an id-less
  // thread reached the client — nothing was observed, so leave(null) had no id to record.
  it('New before the id-less thread\'s first frame: its user-message, chunk and conversation frames are all dropped', async () => {
    const c = client()
    c.submit() // sent A's first message
    c.newConversation() // ...and clicked New before a single frame of it came back
    c.user('A', 45, 'ua', 'long question')
    c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    c.chunk('A', 45, { type: 'text-start', id: 't' })
    c.chunk('A', 45, { type: 'text-delta', id: 't', delta: 'GHOST' })
    c.receive({ type: 'conversation', conversationId: 'A', title: 'A', cid: 'A' })
    for (let i = 0; i < 5; i++) await tick()
    expect(c.messages).toEqual([])
    expect(c.view.conversationId).toBeNull()
    // Then typing in the new thread: its frames and its own id are accepted, and a late A
    // straggler (learned as left while nothing was submitted) stays dropped.
    c.submit()
    // A renderable late straggler (A's next queued turn's user-message) — only dropped because
    // A's cid was learned as left from the frames that arrived before the submit.
    c.user('A', 46, 'ua2', 'LATE GHOST')
    c.user('N', 47, 'un', 'hello'); c.chunk('N', 47, { type: 'start', messageId: 'an' })
    c.chunk('N', 47, { type: 'finish' })
    c.receive({ type: 'conversation', conversationId: 'N', title: 'N', cid: 'N' })
    await c.turns.settled()
    expect(c.messages.map(m => m.id)).toEqual(['un', 'an'])
    expect(c.view.conversationId).toBe('N')
  })

  // Round 5, finding 1: a LEFT thread's first turn persisting in the gap before the server
  // processed `new` must not re-point the empty new thread at it.
  it('a left id-less thread\'s conversation frame is not adopted after New (before or after the next submit)', async () => {
    const c = client()
    c.submit()
    c.user('A', 45, 'ua', 'q'); c.chunk('A', 45, { type: 'start', messageId: 'a45' })
    await tick()
    c.newConversation()
    c.receive({ type: 'conversation', conversationId: 'A', title: 'A', cid: 'A' })
    expect(c.view.conversationId).toBeNull()
    c.submit()
    c.receive({ type: 'conversation', conversationId: 'A', title: 'A', cid: 'A' })
    expect(c.view.conversationId).toBeNull()
    // B's own frames are not dropped by a wrongly adopted A.
    c.user('B', 47, 'ub', 'hi'); c.chunk('B', 47, { type: 'start', messageId: 'bb' }); c.chunk('B', 47, { type: 'finish' })
    await c.turns.settled()
    expect(c.messages.map(m => m.id)).toEqual(['ub', 'bb'])
  })

  it('resuming away from an id-less thread: its later conversation frame is not adopted', () => {
    const c = client()
    c.submit()
    c.user('A', 45, 'ua', 'q')
    c.resume('C')
    c.receive({ type: 'conversation', conversationId: 'A', title: 'A', cid: 'A' })
    expect(c.view.conversationId).toBe('C')
  })
})
