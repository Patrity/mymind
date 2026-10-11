// Cycle 81 (workstreams): runAgent's segment hooks, against the REAL AI SDK loop (mock model) —
// shouldStop ends the loop after the CURRENT step (never mid-step, never another model call, no
// forced-final follow-up); onStep fires once per finished step with that step's usage; the
// workstream prompt block reaches buildSystemPrompt.
import { describe, it, expect } from 'vitest'
import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { runAgent, type StepUsage } from './run'
import type { AgentTool } from './types'

const finish = (r: 'tool-calls' | 'stop', i: number, o: number) => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage: { inputTokens: { total: i }, outputTokens: { total: o } } })
const call = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'work', input: '{}' })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]

function scripted(steps: unknown[][]) {
  let calls = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(calls++, steps.length - 1)]!
      return { stream: convertArrayToReadableStream(chunks as never) }
    }
  })
  return { model, calls: () => calls }
}

async function run(model: MockLanguageModelV3, o: { shouldStop?: () => boolean; onStep?: (s: StepUsage) => void; onTool?: () => void; maxSteps?: number; prompts?: unknown[] }) {
  const work: AgentTool = { name: 'work', toolset: 'memory', description: 'w', kind: 'read', schema: {}, handler: async () => { o.onTool?.(); return { result: { ok: true }, summary: 'worked' } } }
  const out: string[] = []
  for await (const ev of runAgent([{ role: 'user', content: 'go' }], {
    signal: new AbortController().signal, maxSteps: o.maxSteps ?? 10, shouldStop: o.shouldStop, onStep: o.onStep,
    workstream: { goal: 'G', used: { steps: 0, wallMs: 0 }, budget: { maxSteps: 400, maxWallMs: 7_200_000 } }
  }, {
    streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools: [work],
    buildSystemPrompt: async (p) => { o.prompts?.push(p); return 's' }
  })) if (ev.type === 'tool-result') out.push(ev.name)
  return out
}

describe('runAgent segment hooks', () => {
  it('shouldStop flipping during a step ends the loop after that step — no further model call, no forced final', async () => {
    const { model, calls } = scripted([[call('a'), finish('tool-calls', 10, 2)], [call('b'), finish('tool-calls', 20, 3)], [...text('done'), finish('stop', 1, 1)]])
    let stop = false
    const ran = await run(model, { shouldStop: () => stop, onTool: () => { stop = true } })
    expect(ran).toEqual(['work'])
    expect(calls()).toBe(1)
  })
  it('without a stop the loop goes on (control)', async () => {
    const { model, calls } = scripted([[call('a'), finish('tool-calls', 10, 2)], [call('b'), finish('tool-calls', 20, 3)], [...text('done'), finish('stop', 1, 1)]])
    const ran = await run(model, { shouldStop: () => false })
    expect(ran).toEqual(['work', 'work'])
    expect(calls()).toBe(3)
  })
  it('onStep fires once per finished step with that step\'s own usage', async () => {
    const { model } = scripted([[call('a'), finish('tool-calls', 10, 2)], [call('b'), finish('tool-calls', 20, 3)], [...text('done'), finish('stop', 7, 1)]])
    const steps: StepUsage[] = []
    await run(model, { onStep: s => steps.push(s) })
    expect(steps.map(s => [s.inputTokens, s.outputTokens])).toEqual([[10, 2], [20, 3], [7, 1]])
  })
  it('the workstream block reaches buildSystemPrompt', async () => {
    const { model } = scripted([[...text('hi'), finish('stop', 1, 1)]])
    const prompts: Array<{ workstream?: { goal: string } }> = []
    await run(model, { prompts })
    expect(prompts[0]?.workstream?.goal).toBe('G')
  })
})
