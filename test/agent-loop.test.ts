// test/agent-loop.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runAgentLoop } from '../server/lib/agent/loop'
import type { AgentTool } from '../server/lib/agent/types'
import type { StreamChunk } from '../server/lib/ai/chat-stream'

function streamOf(chunks: StreamChunk[]) {
  return (async function* () {
    for (const c of chunks) yield c
  }())
}

const fakeTool: AgentTool = {
  name: 'create_task', description: 'x', kind: 'create',
  schema: {}, handler: async () => ({ result: { id: 't1', title: 'milk' }, summary: 'added \'milk\' to todo', undo: async () => {} })
}

describe('runAgentLoop', () => {
  it('runs a tool round then streams the final answer, emitting events', async () => {
    const calls = [
      streamOf([{ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'milk' } }] }]),
      streamOf([{ textDelta: 'Added milk ' }, { textDelta: 'to your list.' }])
    ]
    let i = 0
    const streamChat = vi.fn(() => calls[i++])

    const events: string[] = []
    let text = ''
    for await (const ev of runAgentLoop(
      [{ role: 'user', content: 'remind me to buy milk' }],
      { signal: new AbortController().signal },
      { streamChat: streamChat as never, tools: [fakeTool] }
    )) {
      events.push(ev.type)
      if (ev.type === 'text-delta') text += ev.text
    }

    expect(text).toContain('Added milk to your list.')
    expect(events).toContain('tool-start')
    expect(events).toContain('tool-result')
    expect(events[events.length - 1]).toBe('done')
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it('emits a filler before running tools', async () => {
    const calls = [
      streamOf([{ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'x' } }] }]),
      streamOf([{ textDelta: 'done' }])
    ]
    let i = 0
    const out: string[] = []
    const events: string[] = []
    for await (const ev of runAgentLoop(
      [{ role: 'user', content: 'add x' }],
      { signal: new AbortController().signal },
      { streamChat: (() => calls[i++]) as never, tools: [fakeTool] }
    )) {
      events.push(ev.type)
      if (ev.type === 'text-delta') out.push(ev.text)
    }
    expect(out[0].length).toBeGreaterThan(0)
    expect(out.join('')).toContain('done')
    expect(events.indexOf('text-delta')).toBeLessThan(events.indexOf('tool-start'))
  })

  it('builds correct OpenAI tool-call message history for the follow-up call', async () => {
    const calls = [
      streamOf([{ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'milk' } }] }]),
      streamOf([{ textDelta: 'done' }])
    ]
    let i = 0
    const spy = vi.fn(() => calls[i++])
    // drain

    for await (const _ of runAgentLoop(
      [{ role: 'user', content: 'add milk' }],
      { signal: new AbortController().signal },
      { streamChat: spy as never, tools: [fakeTool] }
    )) { /* drain */ }

    const secondCallMessages = spy.mock.calls[1][1] as Array<Record<string, unknown>>
    const assistant = secondCallMessages.find(
      m => m.role === 'assistant' && Array.isArray(m.tool_calls)
    ) as { tool_calls: { id: string, type: string, function: { name: string, arguments: string } }[] } | undefined
    expect(assistant).toBeTruthy()
    expect(assistant!.tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'create_task' } })
    expect(typeof assistant!.tool_calls[0].function.arguments).toBe('string') // JSON string, not object
    expect(JSON.parse(assistant!.tool_calls[0].function.arguments)).toEqual({ title: 'milk' })

    const toolMsg = secondCallMessages.find(m => m.role === 'tool') as
      { tool_call_id: string, name: string, content: string } | undefined
    expect(toolMsg).toMatchObject({ tool_call_id: 'c1', name: 'create_task' })
    expect(typeof toolMsg!.content).toBe('string')
  })
})
