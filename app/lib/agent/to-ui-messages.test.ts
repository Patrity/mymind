import { describe, it, expect } from 'vitest'
import { toUIMessages, type ResumeMessage } from './to-ui-messages'
import { applyImageEmbeds, sanitizedOffset } from '../../../server/lib/agent/image-embed'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

type ToolCall = NonNullable<ResumeMessage['toolCalls']>[number]
const tc = (o: Partial<ToolCall> = {}): ToolCall => ({ name: 'web_search', summary: 'searched', callId: 'c1', textOffset: 0, args: { q: 'a' }, result: { hits: 1 }, kind: 'read', ...o })
const msg = (o: Partial<ResumeMessage> = {}): ResumeMessage => ({ id: 'm1', role: 'assistant', content: 'hello', ...o })
const shape = (m: AgentUIMessage) => m.parts.map(p => p.type === 'text' ? ['text', p.text] : p.type === 'dynamic-tool' ? ['tool', p.toolCallId] : [p.type])

describe('toUIMessages', () => {
  it('interleaves text → tool → text at each offset, in ONE message', () => {
    const [m] = toUIMessages([msg({ content: 'Looking. Found it.', toolCalls: [tc({ textOffset: 'Looking. '.length })] })])
    expect(shape(m!)).toEqual([['text', 'Looking. '], ['tool', 'c1'], ['text', 'Found it.']])
    expect(m!.parts[1]).toEqual({
      type: 'dynamic-tool', toolName: 'web_search', toolCallId: 'c1', state: 'output-available', input: { q: 'a' },
      output: { value: { hits: 1 }, summary: 'searched', kind: 'read' }
    })
  })

  it('a server-recorded offset splits the persisted content on a word boundary', () => {
    const before = '\nOkay. '
    const { content } = applyImageEmbeds(before + ' Done.', [])
    expect(content).toBe('Okay. Done.')
    const [good] = toUIMessages([msg({ content, toolCalls: [tc({ textOffset: sanitizedOffset(before) })] })])
    expect(shape(good!)).toEqual([['text', 'Okay. '], ['tool', 'c1'], ['text', 'Done.']])
  })

  it('falls back to tools-first for a legacy row with no offsets', () => {
    const [m] = toUIMessages([msg({ content: 'done', toolCalls: [{ name: 'x', summary: 's', undoToken: 'u' }] })])
    expect(shape(m!)).toEqual([['tool', 'm1-tool-0'], ['text', 'done']])
    expect(m!.parts[0]).toMatchObject({ output: { undoToken: 'u' }, input: {} })
  })

  it('falls back — without dropping any record — when offsets are MIXED', () => {
    const [m] = toUIMessages([msg({ content: 'done', toolCalls: [tc({ textOffset: 2 }), { name: 'legacy', summary: 's' }] })])
    expect(shape(m!)).toEqual([['tool', 'c1'], ['tool', 'm1-tool-1'], ['text', 'done']])
  })

  it('leaves no empty trailing text when the tool ends the reply', () => {
    const [m] = toUIMessages([msg({ content: 'All set.', toolCalls: [tc({ textOffset: 8 })] })])
    expect(shape(m!)).toEqual([['text', 'All set.'], ['tool', 'c1']])
  })

  it('puts persisted reasoning first and carries usage/createdAt as metadata', () => {
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    const [m] = toUIMessages([msg({ content: 'hey', reasoning: 'hmm', usage, createdAt: '2026-01-01T00:00:00.000Z' })])
    expect(m!.parts[0]).toEqual({ type: 'reasoning', text: 'hmm', state: 'done' })
    expect(m!.metadata).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', usage })
  })

  it('clamps out-of-range and negative offsets', () => {
    const [m] = toUIMessages([msg({ content: 'abcdefghij', toolCalls: [tc({ callId: 'a', textOffset: -5 }), tc({ callId: 'b', textOffset: 9999 })] })])
    expect(shape(m!)).toEqual([['tool', 'a'], ['text', 'abcdefghij'], ['tool', 'b']])
  })

  it('never duplicates or loses text when a later offset is smaller (non-monotonic sanitizedOffset)', () => {
    const [m] = toUIMessages([msg({ content: 'abcdefghij', toolCalls: [tc({ callId: 'c1', textOffset: 6 }), tc({ callId: 'c2', textOffset: 2 })] })])
    expect(m!.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')).toBe('abcdefghij')
    expect(m!.parts.filter(p => p.type === 'dynamic-tool')).toHaveLength(2)
  })

  it('maps error and denied results to their tool states', () => {
    const [m] = toUIMessages([msg({ content: '', toolCalls: [tc({ callId: 'e', result: { error: '403' } }), tc({ callId: 'd', result: { denied: true } })] })])
    expect(m!.parts[0]).toMatchObject({ state: 'output-error', errorText: '403' })
    expect(m!.parts[1]).toMatchObject({ state: 'output-denied', approval: { id: 'd', approved: false } })
  })

  it('adds a subagent data part right after its tool', () => {
    const steps = [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' as const }]
    const [m] = toUIMessages([msg({ content: 'x', toolCalls: [tc({ textOffset: 0, steps })] })])
    expect(m!.parts.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'dynamic-tool', toolCallId: 'c1' }),
      { type: 'data-subagent', id: 'c1', data: { steps } }
    ])
  })

  it('user turns get text + file parts and metadata.attachments', () => {
    const attachments = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const [u] = toUIMessages([{ id: 'u1', role: 'user', content: 'look', attachments, toolCalls: null }])
    expect(u).toEqual({
      id: 'u1', role: 'user',
      parts: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' }],
      metadata: { attachments }
    })
  })

  it('skips malformed (null) tool records instead of throwing', () => {
    const [m] = toUIMessages([msg({ content: 'ok', toolCalls: [null as never] })])
    expect(shape(m!)).toEqual([['text', 'ok']])
  })

  // The pager is driven entirely by these two fields, and this transform used to drop them:
  // its ResumeMessage Pick listed neither, so however correct the server's branch counting was,
  // the client received `{ index: 1, total: 1 }` for every message and no pager ever rendered.
  // Both roles carry them — an edit branches a USER message, a regenerate an assistant one.
  it('carries branch + siblingIds through to metadata, for both roles', () => {
    const branch = { index: 2, total: 3 }
    const siblingIds = ['s1', 'u1', 's3']
    const [u, a] = toUIMessages([
      { id: 'u1', role: 'user', content: 'q', branch, siblingIds },
      { id: 'a1', role: 'assistant', content: 'a', branch: { index: 1, total: 2 }, siblingIds: ['a1', 'a2'] }
    ])
    expect(u!.metadata).toEqual({ branch, siblingIds })
    expect(a!.metadata).toEqual({ branch: { index: 1, total: 2 }, siblingIds: ['a1', 'a2'] })
    // siblingIds[index - 1] is the message itself — the invariant the pager's
    // `siblingIds[index - 1 + dir]` pick depends on.
    expect(u!.metadata!.siblingIds![u!.metadata!.branch!.index - 1]).toBe('u1')
  })

  it('leaves branch metadata absent when the row carries none, rather than inventing 1/1', () => {
    const [m] = toUIMessages([msg({ content: 'ok' })])
    expect(m!.metadata).toEqual({})
    expect(m!.metadata).not.toHaveProperty('branch')
  })

  it('maps an event row to a system message carrying its origin', () => {
    const [m] = toUIMessages([{ id: 'e1', role: 'event', content: 'check the queue', origin: 'wake:admin', createdAt: '2026-09-27T10:00:00Z' } as never])
    expect(m).toMatchObject({ id: 'e1', role: 'system', parts: [{ type: 'text', text: 'check the queue' }], metadata: { event: { origin: 'wake:admin' } } })
  })
})

// Cycle 75: a user row's `origin` (an iMessage arrival is marked 📱) and an assistant row's
// channel `deliveries` (badged under the reply) are carried into message metadata.
describe('toUIMessages — cycle 75 channel metadata', () => {
  it('forwards an imessage origin on a user row into metadata.origin', () => {
    const [m] = toUIMessages([{ id: 'u1', role: 'user', content: 'hi from my phone', origin: 'imessage:iMessage;-;+15550001111' }])
    expect(m!.role).toBe('user')
    expect(m!.metadata?.origin).toBe('imessage:iMessage;-;+15550001111')
  })

  it('a user row without an origin has no metadata.origin', () => {
    const [m] = toUIMessages([{ id: 'u1', role: 'user', content: 'typed here', origin: null }])
    expect(m!.metadata).not.toHaveProperty('origin')
  })

  it('does not put origin on an assistant row (its origin is the wake that caused it, not a channel)', () => {
    const [m] = toUIMessages([{ id: 'a1', role: 'assistant', content: 'ok', origin: 'wake:admin' }])
    expect(m!.metadata).not.toHaveProperty('origin')
  })

  it('forwards deliveries on an assistant row', () => {
    const deliveries = [{ channel: 'imessage' as const, status: 'sent' }, { channel: 'email' as const, status: 'pending' }]
    const [m] = toUIMessages([{ id: 'a1', role: 'assistant', content: 'reply', deliveries }])
    expect(m!.metadata?.deliveries).toEqual(deliveries)
  })

  it('an assistant row with no deliveries has no metadata.deliveries', () => {
    const [a, b] = toUIMessages([
      { id: 'a1', role: 'assistant', content: 'reply' },
      { id: 'a2', role: 'assistant', content: 'reply', deliveries: [] }
    ])
    expect(a!.metadata).not.toHaveProperty('deliveries')
    expect(b!.metadata).not.toHaveProperty('deliveries')
  })
})
