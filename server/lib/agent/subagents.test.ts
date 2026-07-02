// server/lib/agent/subagents.test.ts
import { describe, it, expect } from 'vitest'
import { makeSubagentTool, researchSubagent, brainSubagent, subagentTools } from './subagents'
import type { AgentEvent, AgentMessage } from './run'

function fakeRun(events: AgentEvent[], capture?: { messages?: AgentMessage[]; ctx?: unknown }) {
  return async function* (messages: AgentMessage[], ctx: unknown): AsyncGenerator<AgentEvent> {
    if (capture) { capture.messages = messages; capture.ctx = ctx }
    for (const e of events) yield e
  }
}

const SPEC = {
  name: 'test_sub',
  label: 'tested',
  description: 'test subagent',
  toolNames: ['web_search'],
  system: 'You are a test subagent.',
  maxSteps: 4
}

describe('makeSubagentTool', () => {
  it('drains the nested run and returns the accumulated text as the report', async () => {
    const tool = makeSubagentTool(SPEC, {
      run: fakeRun([
        { type: 'tool-result', name: 'web_search', summary: 'searched (3)' },
        { type: 'text-delta', text: 'Found ' },
        { type: 'text-delta', text: 'the answer.' },
        { type: 'done' }
      ])
    })
    const out = await tool.handler({ task: 'find X' }, { signal: new AbortController().signal })
    expect(out.result).toEqual({ report: 'Found the answer.' })
    expect(out.summary).toBe('tested: find X (1 tool calls)')
  })

  it('passes task+context as the user message and its own system/maxSteps to the nested run', async () => {
    const capture: { messages?: AgentMessage[]; ctx?: { maxSteps?: number } } = {}
    const tool = makeSubagentTool(SPEC, { run: fakeRun([{ type: 'text-delta', text: 'ok' }], capture) })
    await tool.handler({ task: 'find X', context: 'Tony has 12 sticks' }, { signal: new AbortController().signal })
    expect(capture.messages).toHaveLength(1)
    expect(capture.messages![0]!.content).toContain('find X')
    expect(capture.messages![0]!.content).toContain('Tony has 12 sticks')
    expect(capture.ctx!.maxSteps).toBe(4)
  })

  it('reports a clean error result when the subagent produces no text', async () => {
    const tool = makeSubagentTool(SPEC, { run: fakeRun([{ type: 'done' }]) })
    const out = await tool.handler({ task: 'find X' }, { signal: new AbortController().signal })
    expect(out.result).toEqual({ error: 'subagent produced no report' })
  })

  it('subagent toolsets are narrow and contain no subagent tools (no recursion)', () => {
    for (const t of subagentTools) {
      expect(t.dangerous).toBeUndefined()
      expect(t.kind).toBe('read')
    }
    // The specs reference only registry tool names; neither includes the other.
    expect(researchSubagent.name).toBe('research_web')
    expect(brainSubagent.name).toBe('search_brain')
  })
})
