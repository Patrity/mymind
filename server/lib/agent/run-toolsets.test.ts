import { describe, it, expect } from 'vitest'
import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { runAgent } from './run'
import { loadToolsetsTool } from './tools/load-toolsets'
import type { AgentTool } from './types'
import type { ToolsetId } from './toolsets'

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
const finish = (r: 'tool-calls' | 'stop') => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })

/** steps[i] = chunks the model emits on call i (last entry repeats). Records offered tool names per call. */
function scripted(steps: unknown[][]) {
  const offered: string[][] = []
  let i = 0
  const model = new MockLanguageModelV3({
    doStream: async (opts: { tools?: Array<{ name: string }> }) => {
      offered.push((opts.tools ?? []).map(t => t.name).sort())
      const chunks = steps[Math.min(i++, steps.length - 1)]!
      return { stream: convertArrayToReadableStream(chunks as never) }
    }
  })
  return { model, offered }
}

const ran: string[] = []
const mk = (name: string, toolset: ToolsetId, schema: AgentTool['schema'] = {}): AgentTool =>
  ({ name, toolset, description: name, kind: 'read', schema, handler: async () => { ran.push(name); return { result: { ok: true }, summary: name } } })
const registry = [mk('core_read', 'memory'), loadToolsetsTool, mk('gen', 'images', { prompt: z.string() }), mk('jobby', 'jobs')]

async function run(model: MockLanguageModelV3, toolsets?: { initial: ToolsetId[]; onChange?: (l: ToolsetId[]) => void | Promise<void> }, tools = registry) {
  ran.length = 0
  for await (const _ of runAgent([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal, maxSteps: 5, toolsets },
    { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools, buildSystemPrompt: async () => 's' })) { /* drain */ }
}

describe('runAgent toolsets', () => {
  it('offers only core tools when nothing is loaded', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: [] })
    expect(offered[0]).toEqual(['core_read', 'load_toolsets'])
  })

  it('offers loaded sets from initial', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: ['images'] })
    expect(offered[0]).toEqual(['core_read', 'gen', 'load_toolsets'])
  })

  it('without ctx.toolsets every tool is offered (subagents, legacy callers)', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, undefined)
    expect(offered[0]).toEqual(['core_read', 'gen', 'jobby', 'load_toolsets'])
  })

  it('load_toolsets makes the set visible on the next step and fires onChange', async () => {
    const changes: ToolsetId[][] = []
    const { model, offered } = scripted([[call('c1', 'load_toolsets', { ids: ['jobs'] }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [], onChange: l => { changes.push(l) } })
    expect(offered[1]).toContain('jobby')
    expect(changes).toEqual([['jobs']])
  })

  it('a direct call to an unloaded tool runs and loads its set (D3)', async () => {
    const changes: ToolsetId[][] = []
    const { model, offered } = scripted([[call('c1', 'gen', { prompt: 'x' }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [], onChange: l => { changes.push(l) } })
    expect(ran).toContain('gen')
    expect(offered[1]).toContain('gen')
    expect(changes).toEqual([['images']])
  })

  it('a call on the LAST step (no later prepareStep) still loads + persists its set via execute', async () => {
    // The prepareStep scan also sees valid calls, so only this case proves the onToolCalled hook:
    // with maxSteps 1 no prepareStep follows the call, and only execute() can load the set.
    const changes: ToolsetId[][] = []
    const { model } = scripted([[call('c1', 'gen', { prompt: 'x' }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    ran.length = 0
    for await (const _ of runAgent([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal, maxSteps: 1, toolsets: { initial: [], onChange: l => { changes.push(l) } } },
      { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools: registry, buildSystemPrompt: async () => 's' })) { /* drain */ }
    expect(ran).toContain('gen')
    expect(changes).toEqual([['images']])
  })

  it('an INVALID call to an unloaded tool still loads its set so the model sees the schema next step', async () => {
    const { model, offered } = scripted([[call('c1', 'gen', { wrong: 1 }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [] })
    expect(ran).not.toContain('gen')
    expect(offered[1]).toContain('gen')
  })

  it('a throwing onChange does not fail the turn', async () => {
    const { model } = scripted([[call('c1', 'gen', { prompt: 'x' }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await expect(run(model, { initial: [], onChange: () => { throw new Error('db down') } })).resolves.toBeUndefined()
    expect(ran).toContain('gen')
  })

  it('a tool absent from the registry (headless-excluded) is never offered even if its set is loaded', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: ['jobs'] }, registry.filter(t => t.name !== 'jobby'))
    expect(offered[0]).not.toContain('jobby')
  })
})
