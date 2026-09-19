import { describe, it, expect } from 'vitest'
import { readUIMessageStream } from 'ai'
import { createTurnStream } from './turn-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'

function harness(attachments?: Parameters<typeof createTurnStream>[0]['attachments']) {
  const frames: (Record<string, unknown> | Uint8Array)[] = []
  let n = 0
  const ts = createTurnStream({
    turnId: 7, attachments,
    send: d => frames.push(typeof d === 'string' ? JSON.parse(d) : d),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
    newId: () => `id${n++}`
  })
  const json = () => frames.filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array))
  const chunks = () => json().filter(f => f.type === 'chunk').map(f => (f as AgentMessageFrame & { type: 'chunk' }).chunk)
  return { ts, frames, json, chunks }
}

async function assemble(chunks: AgentUIChunk[]) {
  const stream = new ReadableStream<AgentUIChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } })
  let m: AgentUIMessage | undefined
  for await (const x of readUIMessageStream<AgentUIMessage>({ stream, onError: () => {} })) m = x
  return m!
}

describe('createTurnStream', () => {
  it('sends the user turn as a user-message with file parts and metadata.attachments', () => {
    const att = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const h = harness(att)
    h.ts.emit({ type: 'transcript', role: 'user', text: 'look' })
    expect(h.json()).toEqual([{
      type: 'user-message', turnId: 7,
      message: {
        id: 'id1', role: 'user',
        parts: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' }],
        metadata: { createdAt: '2026-09-19T00:00:00.000Z', attachments: att }
      }
    }])
  })

  it('stamps every chunk with the turnId and starts the message lazily', async () => {
    const h = harness()
    h.ts.emit({ type: 'state', state: 'thinking' })
    expect(h.chunks()).toEqual([])
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'hi' })
    h.ts.finish()
    expect(h.json().filter(f => f.type === 'chunk').every(f => f.turnId === 7)).toBe(true)
    const m = await assemble(h.chunks())
    expect(m.parts.filter(p => p.type === 'text')).toEqual([{ type: 'text', text: 'hi', state: 'done' }])
  })

  it('sends no chunks at all for a turn with no assistant output', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'user', text: 'hi' })
    h.ts.finish()
    expect(h.chunks()).toEqual([])
  })

  it('adds turnId to audio-begin and passes PCM, audio-end and state through', () => {
    const h = harness()
    const pcm = new Uint8Array([1, 2])
    h.ts.emit({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 })
    h.ts.emit({ type: 'audio', bytes: pcm })
    h.ts.emit({ type: 'audio-end', segmentId: 1 })
    h.ts.emit({ type: 'state', state: 'speaking' })
    expect(h.frames).toEqual([
      { type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: 7 },
      pcm,
      { type: 'audio-end', segmentId: 1 },
      { type: 'state', state: 'speaking' }
    ])
  })

  it('lands text emitted after state:idle (the image-embed append) before finish', async () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'Here.' })
    h.ts.emit({ type: 'state', state: 'idle' })
    h.ts.emit({ type: 'transcript', role: 'assistant', text: '\n\n![c](/api/images/i1/raw)' })
    h.ts.finish()
    const m = await assemble(h.chunks())
    expect(m.parts.find(p => p.type === 'text')).toMatchObject({ text: 'Here.\n\n![c](/api/images/i1/raw)' })
  })

  it('error: error chunk, then the legacy error + idle frames, then silence', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'part' })
    h.ts.error('model down')
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'late' })
    const tail = h.json().slice(-3)
    expect(tail[0]).toMatchObject({ type: 'chunk', chunk: { type: 'error', errorText: 'model down' } })
    expect(tail.slice(1)).toEqual([{ type: 'error', message: 'model down' }, { type: 'state', state: 'idle' }])
    expect(JSON.stringify(h.json())).not.toContain('late')
  })

  it('abort: an abort chunk, then silence', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'part' })
    h.ts.abort()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'late' })
    h.ts.finish()
    expect(h.chunks().at(-1)).toEqual({ type: 'abort' })
    expect(JSON.stringify(h.json())).not.toContain('late')
  })
})
