// test/ai-tools.test.ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildAiTools } from '../server/lib/agent/ai-tools'
import type { AgentTool } from '../server/lib/agent/types'

const fake: AgentTool = {
  name: 'create_task', description: 'x', kind: 'create',
  schema: { title: z.string() },
  handler: async () => ({ result: { id: 't1', title: 'milk' }, summary: "added 'milk' to todo", undo: async () => {} })
}

describe('buildAiTools', () => {
  it('produces a ToolSet keyed by tool name with an execute that runs the handler + emits a tool-result event with an undo token', async () => {
    const events: any[] = []
    const tools = buildAiTools([fake], { signal: new AbortController().signal, onEvent: e => events.push(e) })
    expect(Object.keys(tools)).toEqual(['create_task'])
    const out = await tools.create_task.execute!({ title: 'milk' }, { toolCallId: 'c1', messages: [] } as never)
    expect(out).toMatchObject({ id: 't1', title: 'milk' })
    expect(events.some(e => e.type === 'tool-start' && e.name === 'create_task')).toBe(true)
    expect(events.some(e => e.type === 'tool-result' && e.summary.includes('milk') && e.undoToken)).toBe(true)
  })
})
