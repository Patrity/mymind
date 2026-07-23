// test/run-agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../server/lib/agent/run'

function fakeFullStream(parts: any[]) {
  return { fullStream: (async function* () { for (const p of parts) yield p })() }
}

describe('runAgent', () => {
  it('maps fullStream text-delta parts to text-delta events and ends with done', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'text-delta', id: 't', delta: 'Hello ' },
      { type: 'text-delta', id: 't', delta: 'Tony' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(text).toBe('Hello Tony')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('forces the FINAL allowed step to be text-only so a run can never end on a tool call', async () => {
    const streamText = vi.fn(() => fakeFullStream([]))
    for await (const _ of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal, maxSteps: 4 },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) { /* drain */ }
    const args = streamText.mock.calls[0]![0] as unknown as { prepareStep: (o: { stepNumber: number }) => unknown }
    expect(args.prepareStep({ stepNumber: 0 })).toBeUndefined()
    expect(args.prepareStep({ stepNumber: 2 })).toBeUndefined()
    expect(args.prepareStep({ stepNumber: 3 })).toEqual({ toolChoice: 'none' }) // last of 4 (0-indexed)
  })

  it('forces a text-only follow-up when a run ends with tool calls but no assistant text', async () => {
    // Live failure: "What'd we work on yesterday?" ran search_docs + list_documents,
    // then the reasoning model ended the turn emitting NO text → no reply was persisted.
    const streamText = vi.fn()
      .mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: {} }
          yield { type: 'finish', finishReason: 'stop' }
        })(),
        response: Promise.resolve({ messages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: {} }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search_docs', output: { type: 'text', value: 'nothing' } }] }
        ] })
      })
      .mockReturnValueOnce(fakeFullStream([
        { type: 'text-delta', id: 't', delta: 'Yesterday we shipped the OAuth connector.' },
        { type: 'finish', finishReason: 'stop' }
      ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'what did we work on yesterday' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(text).toBe('Yesterday we shipped the OAuth connector.')
    expect(streamText).toHaveBeenCalledTimes(2)
    expect((streamText.mock.calls[1]![0] as { toolChoice?: unknown }).toolChoice).toBe('none')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('does NOT force a follow-up when the run already produced text (no extra model call)', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: {} },
      { type: 'text-delta', id: 't', delta: 'Done.' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(streamText).toHaveBeenCalledTimes(1)
    expect(events.filter(e => e.type === 'text-delta').map(e => e.text).join('')).toBe('Done.')
  })

  it('maps fullStream reasoning-delta parts to reasoning-delta events', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'Let me ' },
      { type: 'reasoning-delta', id: 'r', delta: 'think.' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', delta: 'Answer.' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    const reasoning = events.filter(e => e.type === 'reasoning-delta').map(e => e.text).join('')
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(reasoning).toBe('Let me think.')
    expect(text).toBe('Answer.')
  })

  it('recovers when the model emits a tool call as plain text (marker + no real tool-call)', async () => {
    // Live failure (conversation 054f2560): the turn ended with a literal
    // "<tool_call><function=exec>…</tool_call>" streamed as TEXT — never executed.
    const streamText = vi.fn()
      .mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', id: 't', delta: 'Let me get all 10 projects.\n<tool_call>\n<function=exec>\n</tool_call>' }
          yield { type: 'finish', finishReason: 'stop' }
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'Let me get all 10 projects.' }] })
      })
      .mockReturnValueOnce(fakeFullStream([
        { type: 'text-delta', id: 't2', delta: 'Here are the 10 projects: …' },
        { type: 'finish', finishReason: 'stop' }
      ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'do it' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(streamText).toHaveBeenCalledTimes(2)
    // recovery MUST allow tools (so the call can actually run) — not toolChoice:'none'
    expect((streamText.mock.calls[1]![0] as { toolChoice?: unknown }).toolChoice).toBeUndefined()
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(text).toContain('Here are the 10 projects')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('does NOT recover when a real tool-call fired even if prose contains <tool_call>', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: {} },
      { type: 'text-delta', id: 't', delta: 'The <tool_call> tag is how Qwen writes calls.' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'explain tool calls' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(streamText).toHaveBeenCalledTimes(1) // sawToolCall true → marker is prose, no false-positive re-run
  })
})
