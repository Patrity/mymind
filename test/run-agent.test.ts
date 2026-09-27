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
    // prepareStep is async now (it awaits ctx.drainSteer when present) — the final-step
    // toolChoice guarantee is unchanged, just delivered via a resolved promise.
    const args = streamText.mock.calls[0]![0] as unknown as { prepareStep: (o: { stepNumber: number; messages: unknown[] }) => Promise<unknown> }
    await expect(args.prepareStep({ stepNumber: 0, messages: [] })).resolves.toBeUndefined()
    await expect(args.prepareStep({ stepNumber: 2, messages: [] })).resolves.toBeUndefined()
    await expect(args.prepareStep({ stepNumber: 3, messages: [] })).resolves.toEqual({ toolChoice: 'none' }) // last of 4 (0-indexed)
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

  it('maps a `finish` part carrying totalUsage to a usage event', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'text-delta', id: 't', delta: 'Hello Tony' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 } }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    const usage = events.find(e => e.type === 'usage')
    expect(usage).toEqual({ type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 })
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('yields no usage event, and does not throw, when `finish` carries no usable usage', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'text-delta', id: 't', delta: 'Hello Tony' },
      { type: 'finish', finishReason: 'stop' } // no totalUsage at all — the common shape in existing fixtures above
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(events.some(e => e.type === 'usage')).toBe(false)
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })

  it('tolerates a differently-shaped or malformed totalUsage without throwing', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'text-delta', id: 't', delta: 'Hi' },
      { type: 'finish', finishReason: 'stop', totalUsage: 'not-an-object' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    expect(events.some(e => e.type === 'usage')).toBe(false)
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })
})

describe('runAgent — steering via prepareStep', () => {
  // SDK verification (AI SDK 6.0.198, node_modules/ai/dist/index.mjs streamStep): each step
  // recomputes `stepInputMessages = [...initialMessages, ...responseMessages]` FRESH — the
  // model's own accumulated response messages, never a previous prepareStep call's returned
  // `messages` override. So a returned `messages` array applies to THAT step's API call only
  // and does not carry into later steps; runAgent must re-splice a drained steer on every
  // subsequent step itself (see server/lib/agent/runtime/steer.ts). This fake mirrors that
  // exactly: it calls prepareStep twice with RAW message arrays that do NOT include step 0's
  // spliced-in steer, the same way the real SDK would recompute them.
  it('re-splices a drained steer into every later step (prepareStep messages do not carry forward)', async () => {
    const initialMessages = ['sys-free-history', 'user:q']
    const drainSteer = vi.fn()
      .mockResolvedValueOnce(['actually use the other doc'])
      .mockResolvedValue([])
    const stepOutputs: unknown[] = []
    let capturedPrepareStep: ((o: { stepNumber: number; messages: unknown[] }) => Promise<{ messages?: unknown[] } | undefined>) | undefined
    const streamText = vi.fn((args: { prepareStep: typeof capturedPrepareStep }) => {
      capturedPrepareStep = args.prepareStep
      return {
        fullStream: (async function* () {
          const step0 = await capturedPrepareStep!({ stepNumber: 0, messages: initialMessages })
          stepOutputs.push(step0)
          yield { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: {} }
          // Step 1's raw messages, recomputed fresh by the (faked) SDK from initial + the
          // model's own tool round — NOT including step 0's spliced-in steer.
          const step1Messages = [...initialMessages, 'asst:tool-call', 'tool:result']
          const step1 = await capturedPrepareStep!({ stepNumber: 1, messages: step1Messages })
          stepOutputs.push(step1)
          yield { type: 'text-delta', id: 't', delta: 'done' }
          yield { type: 'finish', finishReason: 'stop' }
        })()
      }
    })
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'q' }],
      { signal: new AbortController().signal, maxSteps: 10, drainSteer },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)

    expect(drainSteer).toHaveBeenCalledTimes(2)
    expect(stepOutputs[0]).toEqual({ messages: ['sys-free-history', 'user:q', { role: 'user', content: 'actually use the other doc' }] })
    // The steer is re-spliced at the SAME logical position (right after the messages that
    // existed when it arrived), even though step 1's raw array has grown around it.
    expect(stepOutputs[1]).toEqual({ messages: ['sys-free-history', 'user:q', { role: 'user', content: 'actually use the other doc' }, 'asst:tool-call', 'tool:result'] })
  })
})
