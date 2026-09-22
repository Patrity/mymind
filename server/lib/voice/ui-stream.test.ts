// Every assertion runs the encoder's output through the SDK's REAL assembler, so a pass means
// "readUIMessageStream builds this message", not "we emitted what we think the docs say".
import { describe, it, expect } from 'vitest'
import { readUIMessageStream } from 'ai'
import { createUIChunkEncoder } from './ui-stream'
// The real label helpers, so "the timing reaches the UI" is asserted as the strings the row
// renders rather than as fields that merely survived the encoder.
import { rateLabel, durationLabel } from '../../../app/lib/agent/metrics'
import type { VoiceEvent } from './orchestrator'
import type { AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'

async function assemble(chunks: AgentUIChunk[]): Promise<{ message: AgentUIMessage; errors: string[] }> {
  const stream = new ReadableStream<AgentUIChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } })
  const errors: string[] = []
  let message: AgentUIMessage | undefined
  for await (const m of readUIMessageStream<AgentUIMessage>({ stream, onError: e => errors.push(String(e)) })) message = m
  return { message: message!, errors }
}

function encodeTurn(events: VoiceEvent[], end: 'finish' | 'error' | 'abort' = 'finish') {
  const enc = createUIChunkEncoder('m1')
  const chunks = [...enc.start('2026-09-19T00:00:00.000Z'), ...events.flatMap(e => enc.encode(e))]
  chunks.push(...(end === 'finish' ? enc.finish() : end === 'error' ? enc.error('boom') : enc.abort()))
  return chunks
}

const visible = (m: AgentUIMessage) => m.parts.filter(p => p.type !== 'step-start')
const text = (t: string): VoiceEvent => ({ type: 'transcript', role: 'assistant', text: t })

describe('createUIChunkEncoder', () => {
  it('interleaves text and a finished tool in stream order', async () => {
    const { message } = await assemble(encodeTurn([
      text('Looking. '),
      { type: 'tool-start', callId: 'c1', name: 'search_docs', args: { q: 'a' } },
      { type: 'tool', callId: 'c1', name: 'search_docs', summary: 'found 2', args: { q: 'a' }, result: { hits: 2 }, kind: 'read', undoToken: 'u1' },
      text('Found '), text('it.')
    ]))
    expect(message.id).toBe('m1')
    expect(message.metadata).toEqual({ createdAt: '2026-09-19T00:00:00.000Z' })
    expect(visible(message)).toEqual([
      { type: 'text', text: 'Looking. ', state: 'done' },
      { type: 'dynamic-tool', toolName: 'search_docs', toolCallId: 'c1', state: 'output-available', input: { q: 'a' },
        output: { value: { hits: 2 }, summary: 'found 2', undoToken: 'u1', kind: 'read' } },
      { type: 'text', text: 'Found it.', state: 'done' }
    ])
  })

  it('shows a running tool as input-available until its result arrives', async () => {
    const enc = createUIChunkEncoder('m1')
    const chunks = [...enc.start('t'), ...enc.encode({ type: 'tool-start', callId: 'c1', name: 'web_fetch', args: { url: 'u' } })]
    const { message } = await assemble(chunks)
    expect(visible(message)).toEqual([{ type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'c1', state: 'input-available', input: { url: 'u' } }])
  })

  it('maps an { error } result to output-error', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'web_fetch', args: {} },
      { type: 'tool', callId: 'c1', name: 'web_fetch', summary: 'failed: web_fetch', args: {}, result: { error: '403' } }
    ]))
    expect(visible(message)[0]).toMatchObject({ state: 'output-error', errorText: '403' })
  })

  it('maps a { denied: true } result to output-denied', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'exec', args: { command: 'rm -rf /' } },
      { type: 'tool', callId: 'c1', name: 'exec', summary: 'denied: exec', args: {}, result: { denied: true } }
    ]))
    expect(visible(message)[0]).toMatchObject({ toolCallId: 'c1', state: 'output-denied' })
  })

  it('synthesizes the input for a result whose tool-start was never seen', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool', callId: 'c9', name: 'x', summary: 's', args: { a: 1 }, result: { ok: true } }
    ]))
    expect(visible(message)[0]).toMatchObject({ toolCallId: 'c9', state: 'output-available', input: { a: 1 } })
  })

  it('ignores a legacy tool event with no callId', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'tool', name: 'x', summary: 's' }, text('ok')]))
    expect(visible(message)).toEqual([{ type: 'text', text: 'ok', state: 'done' }])
  })

  it('keeps reasoning and text as separate parts', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'reasoning', text: 'hmm ' }, { type: 'reasoning', text: 'ok' }, text('Answer')]))
    expect(visible(message)).toEqual([
      { type: 'reasoning', text: 'hmm ok', state: 'done' },
      { type: 'text', text: 'Answer', state: 'done' }
    ])
  })

  it('reconciles subagent steps into ONE data part holding the latest list', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'research_web', args: {} },
      { type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] },
      { type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' }] }
    ]))
    const data = message.parts.filter(p => p.type === 'data-subagent')
    expect(data).toEqual([{ type: 'data-subagent', id: 'c1', data: { steps: [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' }] } }])
  })

  it('lets a later usage supersede an earlier one', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      text('x'),
      { type: 'usage', inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    ]))
    expect(message.metadata?.usage).toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 10 })
    expect(message.parts.some(p => p.type.startsWith('data-'))).toBe(false)
  })

  it('usage metadata carries contextTokens + modelDefId and never undefined keys', async () => {
    const { message } = await assemble(encodeTurn([text('x'), { type: 'usage', inputTokens: 5, totalTokens: 9, contextTokens: 7, modelDefId: 'm1' }]))
    expect(message.metadata?.usage).toEqual({ inputTokens: 5, totalTokens: 9, contextTokens: 7, modelDefId: 'm1' })
    expect(Object.keys(message.metadata!.usage!)).not.toContain('outputTokens')
  })

  // Timing rides the SAME chunk as the tokens. Without it the live readout could only ever show
  // a token count — duration and tok/s waited for a reload to be read back off the persisted
  // row, which is the half-delivered state this closes. ws.ts re-emits usage with the finalized
  // clock just before finish(); this proves the encoder passes those fields through.
  it('usage metadata carries the turn timing, so duration and tok/s are live', async () => {
    const { message } = await assemble(encodeTurn([
      text('x'),
      { type: 'usage', outputTokens: 40, totalTokens: 50, startedAt: '2026-09-22T00:00:00.000Z', ttftMs: 200, durationMs: 2200 }
    ]))
    expect(message.metadata?.usage).toEqual({
      outputTokens: 40, totalTokens: 50, startedAt: '2026-09-22T00:00:00.000Z', ttftMs: 200, durationMs: 2200
    })
    // ...and those are exactly the fields the labels read (app/lib/agent/metrics.ts): 40 tokens
    // over a 2.0s generating window.
    expect(rateLabel(message.metadata!.usage!)).toBe('20.0 tok/s')
    expect(durationLabel(message.metadata!.usage!)).toBe('2.2s')
  })

  it('omits timing keys entirely when the turn recorded none', async () => {
    const { message } = await assemble(encodeTurn([text('x'), { type: 'usage', totalTokens: 9 }]))
    expect(Object.keys(message.metadata!.usage!)).toEqual(['totalTokens'])
  })

  it('appends image-embed text that arrives after state:idle into the same message', async () => {
    const { message } = await assemble(encodeTurn([text('Here.'), { type: 'state', state: 'idle' }, text('\n\n![a cat](/api/images/i1/raw)')]))
    expect(visible(message)).toEqual([{ type: 'text', text: 'Here.\n\n![a cat](/api/images/i1/raw)', state: 'done' }])
  })

  it('ignores user transcripts, state and audio', () => {
    const enc = createUIChunkEncoder('m1')
    expect(enc.encode({ type: 'transcript', role: 'user', text: 'hi' })).toEqual([])
    expect(enc.encode({ type: 'state', state: 'thinking' })).toEqual([])
    expect(enc.encode({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 })).toEqual([])
    expect(enc.encode({ type: 'audio', bytes: new Uint8Array([1]) })).toEqual([])
    expect(enc.encode({ type: 'audio-end', segmentId: 1 })).toEqual([])
  })

  it('an error ending keeps the partial text and reports the error', async () => {
    const { message, errors } = await assemble(encodeTurn([text('partial')], 'error'))
    expect(visible(message)).toEqual([{ type: 'text', text: 'partial', state: 'done' }])
    expect(errors).toEqual(['Error: boom'])
  })

  it('an abort ending keeps the partial text', async () => {
    const { message } = await assemble(encodeTurn([text('partial')], 'abort'))
    expect(visible(message)).toEqual([{ type: 'text', text: 'partial', state: 'done' }])
  })

  it('an approval request puts the tool in approval-requested; approve → output, deny → denied', async () => {
    const start: VoiceEvent = { type: 'tool-start', callId: 'c1', name: 'exec', args: { command: 'df -h' } }
    const ask: VoiceEvent = { type: 'approval-request', approvalId: 'r1', callId: 'c1', name: 'exec' }
    const pending = await assemble(encodeTurn([start, ask]).slice(0, -2)) // no finish: still pending
    expect(pending.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'approval-requested', approval: { id: 'r1' } })
    const ok = await assemble(encodeTurn([start, ask, { type: 'tool', callId: 'c1', name: 'exec', summary: 'ran', args: {}, result: { stdout: 'ok' } }]))
    expect(ok.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-available', approval: { id: 'r1' } })
    const no = await assemble(encodeTurn([start, ask, { type: 'tool', callId: 'c1', name: 'exec', summary: 'denied: exec', args: {}, result: { denied: true } }]))
    expect(no.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-denied' })
  })

  it('an approval request for a call never opened opens it first', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'approval-request', approvalId: 'r9', callId: 'c9', name: 'exec' }]).slice(0, -2))
    expect(message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ toolCallId: 'c9', toolName: 'exec', state: 'approval-requested' })
  })
})
