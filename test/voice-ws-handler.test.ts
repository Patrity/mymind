// test/voice-ws-handler.test.ts
//
// The runtime socket (server/api/voice/ws.ts) driven with a fake peer. The runtime itself is
// mocked — these tests pin what the SOCKET does with frames: which thread it enqueues into,
// what it subscribes to, and which commands it sends the worker (cycle 81: Stop/`/clear` abort, card
// decisions). The approval channel itself is tested in core (runtime/bus-approvals.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted: the handler module calls this Nitro auto-import at import time.
vi.hoisted(() => { (globalThis as Record<string, unknown>).defineWebSocketHandler = (h: unknown) => h })

const m = vi.hoisted(() => ({
  enqueue: vi.fn(),
  // The worker's commands (cycle 81 Task 4). `abort` with awaitResult answers { settled }.
  sendCommand: vi.fn(async (_type: string, _payload: unknown, _o?: unknown): Promise<unknown> => undefined),
  // The thread's still-open cards, re-sent on every attach (fix round 1, I1).
  openCards: vi.fn(async (_cid: string): Promise<unknown[]> => []),
  transcribe: vi.fn(async () => 'spoken words'),
  clear: vi.fn(async () => {}),
  // Cycle 81: the socket subscribes through the run-event relay (frames come off the bus).
  subscribe: vi.fn((_cid: string, _sink: unknown, _o?: unknown) => () => {}),
  synthesize: vi.fn(async function* (_text: string) {
    yield { kind: 'begin' as const, sampleRate: 24000 }
    yield { kind: 'pcm' as const, bytes: new Uint8Array([1, 2]) }
  }),
  order: [] as string[]
}))
vi.mock('@mymind/core/lib/bus/relay', () => ({ runEventRelay: () => ({ subscribe: m.subscribe }) }))
vi.mock('@mymind/core/lib/voice/speak', () => ({ speakWithPreset: (text: string) => m.synthesize(text) }))
vi.mock('@mymind/core/services/voice-presets', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mymind/core/services/voice-presets')>()
  return { ...real, resolveTurnVoice: async () => ({ preset: real.FALLBACK_PRESET, refAudio: null }) }
})
vi.mock('@mymind/core/lib/agent/runtime/queue', () => ({ enqueue: m.enqueue }))
vi.mock('@mymind/core/lib/bus/events', async importOriginal => ({
  ...(await importOriginal<typeof import('@mymind/core/lib/bus/events')>()), openApprovalFrames: m.openCards
}))
vi.mock('@mymind/core/lib/bus/commands', async importOriginal => ({
  ...(await importOriginal<typeof import('@mymind/core/lib/bus/commands')>()), sendCommand: m.sendCommand
}))
vi.mock('@mymind/core/lib/ai/registry/resolve', () => ({ withFailover: (_u: string, fn: (x: unknown) => unknown) => fn({}) }))
vi.mock('@mymind/core/lib/voice/providers', () => ({ sttFromModel: () => ({ transcribe: m.transcribe }) }))
vi.mock('../server/services/conversation-clear', () => ({ clearConversationContext: m.clear }))
vi.mock('@mymind/core/db', () => ({ useDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ at: new Date(0) }] }) }) }) }) }))

import handler from '../server/api/voice/ws'
import type { RelaySink } from '@mymind/core/lib/bus/relay'
import type { HubFrame } from '@mymind/core/lib/bus/events'
import { CommandTimeoutError } from '@mymind/core/lib/bus/commands'

type H = { open: (p: unknown) => void; message: (p: unknown, msg: unknown) => Promise<void>; close: (p: unknown) => void }
const h = handler as unknown as H

function peer() {
  const sent: string[] = []
  return { sent, send: (d: string | Uint8Array) => { if (typeof d === 'string') sent.push(d) } }
}
const frame = (o: Record<string, unknown>) => ({ rawData: JSON.stringify(o), uint8Array: () => new Uint8Array() })
const wav = () => { const b = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]); return { rawData: b, uint8Array: () => b } }
const sessionKeys = () => m.enqueue.mock.calls.map(c => (c[0] as { sessionKey: string }).sessionKey)
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const result = (runId: string, conversationId: string, steered = false) => ({ runId, conversationId, steered, created: false, queuedBehind: false })
/** Let the submit's lock callback run, so its enqueue is genuinely awaiting. */
const inFlight = async () => { await new Promise(r => setTimeout(r, 5)); expect(m.enqueue).toHaveBeenCalledTimes(1) }
const types = (p: { sent: string[] }) => p.sent.map(s => JSON.parse(s) as { type: string; [k: string]: unknown })

const sent = (type: string) => m.sendCommand.mock.calls.filter(c => c[0] === type).map(c => c[1])
/** A fire-and-forget Stop carries a short expiry (M4). */
const stop = (p: Record<string, unknown>) => ({ ...p, expiresAt: expect.any(Number) })

beforeEach(() => {
  vi.clearAllMocks()
  m.sendCommand.mockImplementation(async () => undefined)
  m.openCards.mockImplementation(async () => [])
})

describe('ws runtime socket', () => {
  // Final review C1: every reconnect starts a socket with no view. The text frame names the
  // thread the client is showing, and that wins — the words land in THAT thread, not a new one.
  it('a text frame carrying conversationId on a fresh socket enqueues into THAT thread and follows it', async () => {
    const cid = '0b8e5a52-3f1c-4d7e-9a3b-2c1d0e9f8a7b'
    const p = peer(); h.open(p)
    const sub = m.subscribe
    m.enqueue.mockImplementation(async (req: { sessionKey: string }) => result('r1', req.sessionKey.slice(7)))
    await h.message(p, frame({ type: 'text', text: 'after the restart', conversationId: cid }))
    expect(sessionKeys()).toEqual([`thread:${cid}`])
    expect(sub.mock.calls.map(c => c[0])).toEqual([cid])
  })

  it('the text frame\'s conversationId wins over a stale socket view', async () => {
    const cid = '0b8e5a52-3f1c-4d7e-9a3b-2c1d0e9f8a7b'
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async (req: { sessionKey: string }) => result('r1', req.sessionKey.slice(7)))
    await h.message(p, frame({ type: 'load', conversationId: 'c-elsewhere' }))
    await h.message(p, frame({ type: 'text', text: 'here', conversationId: cid }))
    await h.message(p, frame({ type: 'text', text: 'still here' }))
    expect(sessionKeys()).toEqual([`thread:${cid}`, `thread:${cid}`])
  })

  it('two back-to-back submits on a new thread land in ONE thread (enqueue is serialised)', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async (req: { sessionKey: string }) => result('r2', req.sessionKey.slice(7)))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    const b = h.message(p, frame({ type: 'text', text: 'two' }))
    await new Promise(r => setTimeout(r, 10))
    first.resolve(result('r1', 'c1'))
    await Promise.all([a, b])
    expect(sessionKeys()).toEqual(['thread:new', 'thread:c1'])
  })

  it('a load during an in-flight enqueue is not undone when the enqueue returns', async () => {
    const p = peer(); h.open(p)
    const sub = m.subscribe
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async (req: { sessionKey: string }) => result('r2', req.sessionKey.slice(7)))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    await inFlight()
    await h.message(p, frame({ type: 'load', conversationId: 'c2' }))
    first.resolve(result('r1', 'cNew'))
    await a
    expect(sub.mock.calls.map(c => c[0])).not.toContain('cNew')
    await h.message(p, frame({ type: 'text', text: 'three' }))
    expect(sessionKeys()[1]).toBe('thread:c2')
  })

  it('a `new` during an in-flight new-thread enqueue is not undone either', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise).mockImplementation(async () => result('r2', 'cOther'))
    const a = h.message(p, frame({ type: 'text', text: 'one' }))
    await inFlight()
    await h.message(p, frame({ type: 'new' }))
    first.resolve(result('r1', 'cNew'))
    await a
    await h.message(p, frame({ type: 'text', text: 'two' }))
    expect(sessionKeys()).toEqual(['thread:new', 'thread:new'])
  })

  it('load does not subscribe; attach subscribes + replays in one step', async () => {
    const p = peer(); h.open(p)
    const sub = m.subscribe
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    expect(sub).not.toHaveBeenCalled()
    await h.message(p, frame({ type: 'attach' }))
    expect(sub).toHaveBeenCalledOnce()
    expect(sub.mock.calls[0]![0]).toBe('c1')
    expect(sub.mock.calls[0]![2]).toEqual({ replay: true })
  })

  it('a reconnect attach resumes past the client\'s last seq; run frames carry run + seq for the next one', async () => {
    const p = peer(); h.open(p)
    const run = '0b8e5a52-3f1c-4d7e-9a3b-2c1d0e9f8a7b'
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach', after: { [run]: 12 } }))
    expect(m.subscribe.mock.calls[0]![2]).toEqual({ replay: true, after: { [run]: 12 } })
    const sink = m.subscribe.mock.calls[0]![1] as RelaySink
    sink.deliver({ type: 'persisted', conversationId: 'c1' }, { runId: run, seq: 13 })
    expect(types(p)).toEqual([{ cid: 'c1', run, seq: 13, type: 'persisted', conversationId: 'c1' }])
  })

  it('bus frames reach the peer tagged with their thread; a bus approval arrives in the card\'s shape only', async () => {
    const p = peer(); h.open(p)
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach' }))
    const sink = m.subscribe.mock.calls[0]![1] as RelaySink
    sink.deliver({ type: 'state', state: 'thinking' }, { runId: 'r1', seq: 1 })
    sink.deliver({ type: 'approval', requestId: 'q1', tool: 'exec', command: 'ls', proposedPattern: 'ls *', allowlistable: true, title: 'Run this?', logSummary: 'secret-free', callId: 'k1', args: { a: 1 } } as HubFrame, { runId: 'r1', seq: 2 })
    expect(types(p)).toEqual([
      { cid: 'c1', run: 'r1', seq: 1, type: 'state', state: 'thinking' },
      { cid: 'c1', run: 'r1', seq: 2, type: 'approval', requestId: 'q1', tool: 'exec', command: 'ls', proposedPattern: 'ls *', allowlistable: true, title: 'Run this?' }
    ])
  })

  it('a spoken turn this socket started is synthesized HERE from its streamed text (spec §4); Stop silences it', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('r1', 'c1'))
    await h.message(p, frame({ type: 'text', text: 'hi', speak: true, conversationId: 'c1' }))
    const sink = m.subscribe.mock.calls.at(-1)![1] as RelaySink
    const chunk = (c: Record<string, unknown>) => ({ type: 'chunk', turnId: 9, chunk: c } as unknown as HubFrame)
    sink.deliver({ type: 'user-message', turnId: 9, message: { id: 'u', role: 'user', parts: [] } } as HubFrame, { runId: 'r1', seq: 1 })
    sink.deliver(chunk({ type: 'text-delta', id: 't', delta: 'You have two tasks. ' }), { runId: 'r1', seq: 2 })
    sink.deliver({ type: 'state', state: 'typing' }, { runId: 'r1', seq: 3 })
    await new Promise(r => setTimeout(r, 20))
    expect(m.synthesize).toHaveBeenCalledWith('You have two tasks.')
    const out = types(p)
    expect(out.map(f => f.type)).toEqual(['user-message', 'chunk', 'state', 'audio-begin', 'audio-end'])
    expect(out.find(f => f.type === 'state')).toMatchObject({ state: 'speaking', cid: 'c1' }) // typing withheld
    expect(out.find(f => f.type === 'audio-begin')).toMatchObject({ cid: 'c1', turnId: 9, segmentId: 1, sampleRate: 24000 })
    // A run this socket did not start speaking (another tab's): text only.
    sink.deliver(chunk({ type: 'text-delta', id: 't2', delta: 'Someone else asked this. ' }), { runId: 'r-other', seq: 1 })
    await new Promise(r => setTimeout(r, 20))
    expect(m.synthesize).toHaveBeenCalledTimes(1)
    // Stop: nothing more is spoken for r1.
    await h.message(p, frame({ type: 'interrupt' }))
    sink.deliver(chunk({ type: 'text-delta', id: 't', delta: 'And one more sentence here. ' }), { runId: 'r1', seq: 4 })
    await new Promise(r => setTimeout(r, 20))
    expect(m.synthesize).toHaveBeenCalledTimes(1)
  })

  // Cycle 81 Task 4: the card's request lives in the worker's run; the socket forwards Tony's answer.
  it('approve/deny are forwarded to the worker — only for a card this socket was shown and that is still open', async () => {
    const p = peer(); h.open(p)
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach' }))
    const sink = m.subscribe.mock.calls[0]![1] as RelaySink
    const card = (requestId: string, seq: number) => sink.deliver({ type: 'approval', requestId, tool: 'exec', command: 'git status', proposedPattern: 'git *', allowlistable: true } as HubFrame, { runId: 'r1', seq })
    card('q1', 1); card('q2', 2); card('q3', 3)
    await h.message(p, frame({ type: 'approve', requestId: 'q1', remember: true, pattern: 'git status *' }))
    await h.message(p, frame({ type: 'deny', requestId: 'q2' }))
    // Unknown id (never shown here), a card answered already, a card another tab resolved: dropped.
    await h.message(p, frame({ type: 'approve', requestId: 'q-forged' }))
    await h.message(p, frame({ type: 'approve', requestId: 'q1' }))
    sink.deliver({ type: 'approval-resolved', requestId: 'q3' }, { runId: 'r1', seq: 4 })
    await h.message(p, frame({ type: 'approve', requestId: 'q3' }))
    expect(sent('approval-decision')).toEqual([
      { requestId: 'q1', approved: true, remember: true, pattern: 'git status *' },
      { requestId: 'q2', approved: false }
    ])
  })

  it('a decision the worker cannot be sent is reported, not swallowed', async () => {
    const p = peer(); h.open(p)
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    m.sendCommand.mockImplementationOnce(async () => { throw new Error('db down') })
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach' }))
    const sink = m.subscribe.mock.calls[0]![1] as RelaySink
    sink.deliver({ type: 'approval', requestId: 'q1', tool: 'exec', command: 'ls', proposedPattern: 'ls *' } as HubFrame, { runId: 'r1', seq: 1 })
    await h.message(p, frame({ type: 'approve', requestId: 'q1' }))
    expect(types(p).at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/worker/) })
    // M2: not delivered → the card is still answerable here; the retry goes out.
    await h.message(p, frame({ type: 'approve', requestId: 'q1' }))
    expect(sent('approval-decision')).toHaveLength(2)
  })

  // Fix round 1, I1: a reconnect resumes PAST the card's seq, so the relay never shows it again —
  // every attach re-sends the thread's still-open cards, and they are answerable from this socket.
  it('attach (a reconnect, `after` past the card) re-sends the open cards and accepts a decision for them', async () => {
    const p = peer(); h.open(p)
    const card = { type: 'approval', requestId: 'q9', tool: 'exec', command: 'ls', proposedPattern: 'ls *', allowlistable: true }
    m.openCards.mockImplementation(async () => [{ frame: card, runId: 'r1', seq: 7 }])
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach', after: { '0b8e5a52-3f1c-4d7e-9a3b-2c1d0e9f8a7b': 40 } }))
    await new Promise(r => setTimeout(r, 5))
    expect(m.openCards).toHaveBeenCalledWith('c1')
    // Re-sent without run/seq: it must not move the client's resume cursor.
    expect(types(p)).toEqual([{ ...card, cid: 'c1' }])
    await h.message(p, frame({ type: 'approve', requestId: 'q9' }))
    expect(sent('approval-decision')).toEqual([{ requestId: 'q9', approved: true, remember: false }])
  })

  it('a decision the worker no longer holds (decided elsewhere, timed out, run died) closes the stale card on the page', async () => {
    const p = peer(); h.open(p)
    m.openCards.mockImplementation(async () => [{ frame: { type: 'approval', requestId: 'q1', tool: 'exec', command: 'ls', proposedPattern: 'ls *', allowlistable: true }, runId: 'r1', seq: 1 }])
    m.sendCommand.mockImplementation(async (type: string) => (type === 'approval-decision' ? false : undefined))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach' }))
    await new Promise(r => setTimeout(r, 5))
    await h.message(p, frame({ type: 'deny', requestId: 'q1' }))
    expect(types(p).at(-1)).toEqual({ type: 'approval-resolved', requestId: 'q1', cid: 'c1' })
  })

  it('M1: cards are pruned when the socket leaves their thread and when their run\'s turn ends', async () => {
    const p = peer(); h.open(p)
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'attach' }))
    const sink = m.subscribe.mock.calls[0]![1] as RelaySink
    const card = (requestId: string, runId: string, seq: number) => sink.deliver({ type: 'approval', requestId, tool: 'exec', command: 'ls', proposedPattern: 'ls *', allowlistable: true } as HubFrame, { runId, seq })
    card('qA', 'r1', 1); card('qB', 'r2', 1)
    sink.deliver({ type: 'persisted', conversationId: 'c1' }, { runId: 'r1', seq: 2 }) // r1's turn ended (e.g. its worker died and recovery persisted it)
    await h.message(p, frame({ type: 'approve', requestId: 'qA' }))
    expect(sent('approval-decision')).toEqual([])
    await h.message(p, frame({ type: 'load', conversationId: 'c2' })) // left c1: qB is no longer answerable here
    await h.message(p, frame({ type: 'approve', requestId: 'qB' }))
    expect(sent('approval-decision')).toEqual([])
  })

  it('Stop aborts the viewed thread in the worker — and only it (other threads, and their cards, are untouched)', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async (req: { sessionKey: string }) => result(`run-${req.sessionKey}`, req.sessionKey.slice(7)))
    await h.message(p, frame({ type: 'load', conversationId: 'cA' }))
    await h.message(p, frame({ type: 'text', text: 'a' }))
    await h.message(p, frame({ type: 'load', conversationId: 'cB' }))
    await h.message(p, frame({ type: 'interrupt' }))
    // No runId: this socket's last run is on cA, not the thread in view.
    expect(sent('abort')).toEqual([stop({ conversationId: 'cB' })])
    // Cards are denied by the aborted RUN (worker side), never by a blanket socket-side deny.
    expect(sent('approval-decision')).toEqual([])
  })

  it('Stop aborts this socket\'s last queued run on the viewed thread', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rQ', 'c1'))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'text', text: 'queued behind something' }))
    await h.message(p, frame({ type: 'interrupt' }))
    // One urgent command: the thread's running run AND this socket's last run (maybe still queued).
    expect(sent('abort')).toEqual([stop({ runId: 'rQ', conversationId: 'c1' })])
    // M4: valid for STOP_ABORT_TTL_MS from now — a worker claiming it after an outage ignores it.
    const exp = (sent('abort')[0] as { expiresAt: number }).expiresAt - Date.now()
    expect(exp).toBeGreaterThan(10_000); expect(exp).toBeLessThanOrEqual(15_000)
  })

  it('Stop during an in-flight new-thread enqueue aborts the run that enqueue creates', async () => {
    const p = peer(); h.open(p)
    const first = deferred<ReturnType<typeof result>>()
    m.enqueue.mockImplementationOnce(() => first.promise)
    const a = h.message(p, frame({ type: 'text', text: 'go' }))
    await inFlight()
    await h.message(p, frame({ type: 'interrupt' }))
    expect(sent('abort')).toEqual([])
    first.resolve(result('rNew', 'cNew'))
    await a
    expect(sent('abort')).toEqual([stop({ runId: 'rNew', conversationId: 'cNew' })])
  })

  it('a steered voice utterance returns the client to idle', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rRun', 'c1', true))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, wav())
    const t = types(p).map(f => f.type === 'state' ? `state:${f.state}` : f.type)
    expect(t).toEqual(['state:thinking', 'steered', 'state:idle'])
    // Conversation-scoped: tagged with its thread so the client's cid guard can gate it.
    expect(types(p).find(f => f.type === 'steered')).toEqual({ type: 'steered', text: 'spoken words', cid: 'c1' })
  })

  // Cycle 74: a message queued behind a running HEADLESS run gets a `queued` frame (tagged with
  // its thread, so the client's cid guard can gate it) — the client paints the bubble now.
  it('a text queued behind a headless run sends {type:queued, text, cid}', async () => {
    const p = peer()
    h.open(p)
    m.enqueue.mockImplementation(async () => ({ ...result('rNew', 'c1'), queuedBehind: true }))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'text', text: 'while she works' }))
    expect(types(p).filter(f => f.type === 'queued')).toEqual([{ type: 'queued', text: 'while she works', cid: 'c1' }])
    // Still a run of its own: Stop follows it like any queued turn.
    await h.message(p, frame({ type: 'interrupt' }))
    expect(sent('abort')).toEqual([stop({ runId: 'rNew', conversationId: 'c1' })])
  })

  it('a queued voice utterance returns the client to idle', async () => {
    const p = peer()
    h.open(p)
    m.enqueue.mockImplementation(async () => ({ ...result('rNew', 'c1'), queuedBehind: true }))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, wav())
    const t = types(p).map(f => f.type === 'state' ? `state:${f.state}` : f.type)
    expect(t).toEqual(['state:thinking', 'queued', 'state:idle'])
  })

  it('a text that simply starts a run sends no queued frame', async () => {
    const p = peer()
    h.open(p)
    m.enqueue.mockImplementation(async () => ({ ...result('rNew', 'c1'), queuedBehind: false }))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'text', text: 'hello' }))
    expect(types(p).map(f => f.type)).not.toContain('queued')
  })

  // Spec §3.5 + carry-over: the epoch is written only after the WORKER answers settled:true.
  it('clear waits for the worker\'s settled answer BEFORE writing the epoch', async () => {
    const p = peer(); h.open(p)
    const ack = deferred<{ settled: boolean }>()
    m.sendCommand.mockImplementation(async (type: string) => {
      if (type !== 'abort') return undefined
      const v = await ack.promise; m.order.push('settled'); return v
    })
    m.clear.mockImplementationOnce(async () => { m.order.push('epoch') })
    m.order.length = 0
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    const c = h.message(p, frame({ type: 'clear' }))
    await new Promise(r => setTimeout(r, 5))
    expect(m.clear).not.toHaveBeenCalled()
    ack.resolve({ settled: true })
    await c
    expect(m.order).toEqual(['settled', 'epoch'])
    expect(m.sendCommand).toHaveBeenCalledWith('abort', { conversationId: 'c1' }, { awaitResult: true })
    expect(types(p).at(-1)).toEqual({ type: 'cleared', epochAt: new Date(0).toISOString() })
  })

  it('clear does NOT write the epoch when the worker says the turn has not unwound (settled:false)', async () => {
    const p = peer(); h.open(p)
    m.sendCommand.mockImplementation(async (type: string) => (type === 'abort' ? { settled: false } : undefined))
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'clear' }))
    expect(m.clear).not.toHaveBeenCalled()
    expect(types(p)).toEqual([{ type: 'error', message: expect.stringMatching(/Could not clear/) }])
  })

  it('clear does NOT write the epoch when the worker does not answer in 10s — a visible error instead', async () => {
    const p = peer(); h.open(p)
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    m.sendCommand.mockImplementation(async (type: string) => {
      if (type === 'abort') throw new CommandTimeoutError('abort', 7, 10_000, false)
      return undefined
    })
    await h.message(p, frame({ type: 'load', conversationId: 'c1' }))
    await h.message(p, frame({ type: 'clear' }))
    expect(m.clear).not.toHaveBeenCalled()
    expect(types(p)).toEqual([{ type: 'error', message: expect.stringMatching(/worker did not confirm/) }])
  })

  it('close sends nothing to the worker: open cards stay answerable from other tabs or after a reconnect', async () => {
    const p = peer(); h.open(p)
    m.enqueue.mockImplementation(async () => result('rX', 'c1'))
    await h.message(p, frame({ type: 'text', text: 'x' }))
    m.sendCommand.mockClear()
    h.close(p)
    expect(m.sendCommand).not.toHaveBeenCalled()
  })
})
