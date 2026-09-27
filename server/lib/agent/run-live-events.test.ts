// Proves tool lifecycle events reach runAgent's consumer WHILE the tool is still running.
// Uses the REAL streamText with a mock model: the property under test is how the SDK's
// fullStream behaves during execute(), which a hand-written fake stream cannot reproduce.
import { describe, it, expect, vi } from 'vitest'
import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { runAgent, type AgentEvent } from './run'
import type { AgentTool } from './types'

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
function mockModel() {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      const chunks = call === 1
        ? [{ type: 'tool-call', toolCallId: 'c1', toolName: 'slow', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
        : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]
      return { stream: convertArrayToReadableStream(chunks as never) }
    }
  })
}

async function runWithGatedTool() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const tool: AgentTool = {
    name: 'slow', description: 'slow', kind: 'read', schema: {},
    handler: async (_input, ctx) => {
      // A real subagent emits its nested events OVER TIME, after awaits, while the parent
      // tool is still running — not synchronously before its first await. Model that here:
      // this delay puts the emit on the far side of a tick boundary from tool-start, so the
      // only way it can reach the consumer before the gate releases is a channel that a tool
      // callback can push into directly — a queue drained only when the next fullStream part
      // arrives would leave it stuck (fullStream is silent for the whole gated window).
      await new Promise(r => setTimeout(r, 20))
      ctx.onNestedEvent?.({ type: 'tool-start', name: 'web_search', args: { q: 'x' }, callId: 'n1' })
      await gate
      return { result: { ok: true }, summary: 'slow done' }
    }
  }
  const model = mockModel()
  const seen: AgentEvent[] = []
  const consumed = (async () => {
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal, maxSteps: 3 },
      { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools: [tool], buildSystemPrompt: async () => 's' }
    )) seen.push(e)
  })()
  await new Promise(r => setTimeout(r, 200)) // the tool is now parked on the gate
  const beforeRelease = [...seen]
  release()
  await consumed
  return { beforeRelease, all: seen }
}

describe('runAgent live tool events', () => {
  it('stamps tool-start with the SDK toolCallId', async () => {
    const { all } = await runWithGatedTool()
    expect(all.find(e => e.type === 'tool-start')).toMatchObject({ name: 'slow', callId: 'c1' })
  })

  it('forwards a nested event as subagent-event keyed to the parent call', async () => {
    const { all } = await runWithGatedTool()
    expect(all.find(e => e.type === 'subagent-event')).toEqual({
      type: 'subagent-event', parentCallId: 'c1',
      event: { type: 'tool-start', name: 'web_search', args: { q: 'x' }, callId: 'n1' }
    })
  })

  it('delivers the nested event BEFORE the tool finishes (no end-of-tool burst)', async () => {
    const { beforeRelease } = await runWithGatedTool()
    expect(beforeRelease.map(e => e.type)).toEqual(['tool-start', 'subagent-event'])
  })
})

// Pins the SDK-recomputation assumption steer.ts and run.ts's prepareStep depend on (see
// task-6-report.md): a step's prompt is rebuilt by the REAL SDK from its own accumulated
// state, never from a previous prepareStep call's returned `messages`. Using the real
// streamText + MockLanguageModelV3 (not a hand-written fake fullStream) means an `ai` upgrade
// that changes this recomputation would fail this test, not just our own fake-SDK test.
describe('runAgent steering — real SDK step boundaries', () => {
  it("splices a mid-turn steer into the very next step's prompt exactly once", async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        const chunks = call === 1
          ? [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: '{}' },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
          : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]
        return { stream: convertArrayToReadableStream(chunks as never) }
      }
    })
    const searchDocs: AgentTool = {
      name: 'search_docs', description: 'search', kind: 'read', schema: {},
      handler: async () => ({ result: { hits: 0 }, summary: 'no results' })
    }
    // Nothing queued yet at step 0's boundary; the steer lands at the boundary AFTER step 0's
    // tool call ran — i.e. the drain that happens just before step 1's doStream call.
    const drainSteer = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['check the new spec first'])
      .mockResolvedValue([])
    const events: AgentEvent[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'what did we work on' }],
      { signal: new AbortController().signal, maxSteps: 5, drainSteer },
      { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools: [searchDocs], buildSystemPrompt: async () => 's' }
    )) events.push(e)

    expect(drainSteer).toHaveBeenCalledTimes(2)
    expect(model.doStreamCalls).toHaveLength(2)
    const occurrences = (i: number) => JSON.stringify(model.doStreamCalls[i]!.prompt).split('check the new spec first').length - 1
    expect(occurrences(0)).toBe(0) // step 0: not drained yet
    expect(occurrences(1)).toBe(1) // step 1: spliced in exactly once
  })
})
