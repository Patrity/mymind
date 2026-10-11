// Cycle 81 (spec §4): TTS in the web process. The worker streams a spoken run's TEXT over the bus;
// the voice socket that originated it synthesizes from those deltas (server/lib/voice/socket-tts.ts)
// and the browser must see the frame order the in-process runner used to give it.
import { describe, it, expect, vi } from 'vitest'
import { createSocketTts, type SocketTtsDeps } from '../server/lib/voice/socket-tts'
import type { HubFrame } from '@mymind/core/lib/bus/events'
import { FALLBACK_PRESET } from '@mymind/core/services/voice-presets'

type Sent = { cid: string; frame: Record<string, unknown> } | { bin: Uint8Array }

function harness(o: { gate?: Promise<void> } = {}) {
  const sent: Sent[] = []
  const spoken: string[] = []
  const synthesize = vi.fn(async function* (text: string, opts: { signal?: AbortSignal }) {
    spoken.push(text)
    yield { kind: 'begin' as const, sampleRate: 24000 }
    if (o.gate) await o.gate
    if (opts.signal?.aborted) return
    yield { kind: 'pcm' as const, bytes: new Uint8Array([1, 2]) }
  })
  const resolveVoice = vi.fn(async () => ({ preset: FALLBACK_PRESET, refAudio: null }))
  const deps: SocketTtsDeps = {
    send: (cid, frame) => sent.push({ cid, frame: frame as Record<string, unknown> }),
    sendBinary: bytes => sent.push({ bin: bytes }),
    resolveVoice,
    synthesize: synthesize as never
  }
  const tts = createSocketTts(deps)
  const types = () => sent.map(s => 'bin' in s ? 'PCM' : s.frame.type === 'state' ? `state:${s.frame.state}` : s.frame.type === 'chunk' ? `chunk:${(s.frame.chunk as { type: string }).type}` : String(s.frame.type))
  return { tts, sent, spoken, synthesize, resolveVoice, types }
}

const T = 42
const user = (): HubFrame => ({ type: 'user-message', turnId: T, message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } } as HubFrame)
const chunk = (c: Record<string, unknown>): HubFrame => ({ type: 'chunk', turnId: T, chunk: c } as unknown as HubFrame)
const delta = (d: string) => chunk({ type: 'text-delta', id: 't0', delta: d })
const state = (s: 'thinking' | 'typing' | 'idle' | 'tool'): HubFrame => ({ type: 'state', state: s })
const tick = () => new Promise(r => setTimeout(r, 5))
async function settle() { for (let i = 0; i < 6; i++) await tick() }

/** What the worker's runner publishes for a short spoken turn (text frames only). */
function workerTurn(): HubFrame[] {
  return [
    user(), state('thinking'), chunk({ type: 'start', messageId: 'm1' }), chunk({ type: 'start-step' }),
    chunk({ type: 'text-start', id: 't0' }), delta('You have '), state('typing'), delta('two tasks. '),
    state('idle'), chunk({ type: 'text-end', id: 't0' }), chunk({ type: 'finish-step' }), chunk({ type: 'finish' }),
    { type: 'persisted', conversationId: 'c1' }
  ]
}

describe('socket TTS (web-side speech for the originating socket)', () => {
  it('speaks a sentence once its deltas complete — only for the run this socket originated with speak', async () => {
    const h = harness()
    h.tts.expect('run-1', { presetId: 'p1' })
    h.tts.frame('c1', user(), { runId: 'run-1' })
    h.tts.frame('c1', delta('You have '), { runId: 'run-1' })
    await settle()
    expect(h.spoken).toEqual([]) // not a sentence yet
    h.tts.frame('c1', delta('two tasks. '), { runId: 'run-1' })
    await settle()
    expect(h.spoken).toEqual(['You have two tasks.'])
    expect(h.resolveVoice).toHaveBeenCalledWith('p1')
    // Another run on the same thread (not this socket's, or not spoken): text only, never audio.
    h.tts.frame('c1', delta('Elsewhere a full sentence. And more. '), { runId: 'run-2' })
    await settle()
    expect(h.spoken).toEqual(['You have two tasks.'])
    expect(h.sent.filter(s => 'bin' in s)).toHaveLength(1)
  })

  it('reproduces the old origin-socket order: no typing, speaking + audio, then idle and everything after', async () => {
    const h = harness()
    h.tts.expect('run-1', { presetId: null })
    for (const f of workerTurn()) h.tts.frame('c1', f, { runId: 'run-1' })
    await settle()
    expect(h.types()).toEqual([
      'user-message', 'state:thinking', 'chunk:start', 'chunk:start-step', 'chunk:text-start',
      'chunk:text-delta', 'chunk:text-delta',
      'state:speaking', 'audio-begin', 'PCM', 'audio-end',
      'state:idle', 'chunk:text-end', 'chunk:finish-step', 'chunk:finish', 'persisted'
    ])
    const begin = h.sent.find(s => !('bin' in s) && s.frame.type === 'audio-begin') as { frame: Record<string, unknown> }
    expect(begin.frame).toEqual({ type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: T })
    // every JSON frame is for the run's conversation (the caller tags it with that cid)
    expect(h.sent.every(s => 'bin' in s || s.cid === 'c1')).toBe(true)
  })

  it('a non-spoken run passes through untouched — typing included, nothing held', async () => {
    const h = harness()
    for (const f of workerTurn()) h.tts.frame('c1', f, { runId: 'run-1' })
    expect(h.types()).toContain('state:typing')
    expect(h.types().at(-1)).toBe('persisted')
    expect(h.synthesize).not.toHaveBeenCalled()
  })

  it('holds idle (and the next run\'s frames) until the audio has played out of the pipeline', async () => {
    let open!: () => void
    const h = harness({ gate: new Promise<void>((r) => { open = r }) })
    h.tts.expect('run-1', { presetId: null })
    for (const f of workerTurn()) h.tts.frame('c1', f, { runId: 'run-1' })
    h.tts.frame('c1', { type: 'user-message', turnId: T + 1, message: { id: 'u2', role: 'user', parts: [] } } as HubFrame, { runId: 'run-2' })
    await settle()
    expect(h.types()).not.toContain('state:idle')
    expect(h.types()).not.toContain('persisted')
    open()
    await settle()
    const t = h.types()
    expect(t.indexOf('audio-end')).toBeLessThan(t.indexOf('state:idle'))
    expect(t.slice(t.indexOf('state:idle'))).toEqual(['state:idle', 'chunk:text-end', 'chunk:finish-step', 'chunk:finish', 'persisted', 'user-message'])
  })

  it('barge-in (abort) stops the synthesis at once and releases the held frames', async () => {
    let open!: () => void
    const h = harness({ gate: new Promise<void>((r) => { open = r }) })
    h.tts.expect('run-1', { presetId: null })
    for (const f of workerTurn()) h.tts.frame('c1', f, { runId: 'run-1' })
    await settle()
    expect(h.types()).not.toContain('state:idle')
    h.tts.abort()
    expect(h.types().at(-1)).toBe('persisted') // released synchronously
    open()
    await settle()
    expect(h.sent.filter(s => 'bin' in s)).toHaveLength(0) // the gated PCM never went out
    expect(h.types()).not.toContain('audio-end')
  })

  it('leaving the thread (abort for that conversation) silences only that thread', async () => {
    const h = harness()
    h.tts.expect('run-1', { presetId: null })
    h.tts.expect('run-2', { presetId: null })
    h.tts.frame('c1', user(), { runId: 'run-1' })
    h.tts.frame('c2', user(), { runId: 'run-2' })
    h.tts.abort('c1')
    h.tts.frame('c1', delta('One full sentence here. '), { runId: 'run-1' })
    h.tts.frame('c2', delta('Another full sentence. '), { runId: 'run-2' })
    await settle()
    expect(h.spoken).toEqual(['Another full sentence.'])
  })

  it('never speaks reasoning, and an error frame ends the speech', async () => {
    const h = harness()
    h.tts.expect('run-1', { presetId: null })
    h.tts.frame('c1', user(), { runId: 'run-1' })
    h.tts.frame('c1', chunk({ type: 'reasoning-delta', id: 'r0', delta: 'Thinking hard about it. ' }), { runId: 'run-1' })
    h.tts.frame('c1', delta('Said aloud. '), { runId: 'run-1' })
    await settle()
    expect(h.spoken).toEqual(['Said aloud.'])
    h.tts.frame('c1', chunk({ type: 'error', errorText: 'boom' }), { runId: 'run-1' })
    h.tts.frame('c1', delta('Too late to say this. '), { runId: 'run-1' })
    await settle() // the error CHUNK alone ends it (not only the legacy error frame below)
    expect(h.spoken).toEqual(['Said aloud.'])
    h.tts.frame('c1', { type: 'error', message: 'boom' }, { runId: 'run-1' })
    h.tts.frame('c1', state('idle'), { runId: 'run-1' })
    await settle()
    expect(h.spoken).toEqual(['Said aloud.'])
    expect(h.types().slice(-2)).toEqual(['error', 'state:idle'])
  })
})
