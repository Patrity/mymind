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
})
