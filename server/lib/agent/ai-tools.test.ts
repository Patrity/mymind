// server/lib/agent/ai-tools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildAiTools } from './ai-tools'
import type { AgentTool, ToolContext } from './types'

// Minimal hooks factory
function makeHooks(requestApproval?: (req: unknown) => Promise<{ approved: boolean }>) {
  const events: unknown[] = []
  return {
    signal: new AbortController().signal,
    requestApproval,
    onEvent: (e: unknown) => events.push(e),
    events,
  }
}

function makeReadTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'my_tool',
    description: 'test tool',
    schema: { val: z.string() },
    kind: 'read',
    dangerous: true,
    handler: async () => ({ result: { ok: true }, summary: 'done' }),
    ...overrides,
  }
}

describe('buildAiTools gate — autoApprove fast-path', () => {
  it('skips the prompt when autoApprove returns true', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    const tool = makeReadTool({
      autoApprove: async () => true,
    })
    const set = buildAiTools([tool], hooks)
    const result = await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(requestApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true })
  })

  it('calls requestApproval when autoApprove returns false', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    const tool = makeReadTool({
      autoApprove: async () => false,
    })
    const set = buildAiTools([tool], hooks)
    await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(requestApproval).toHaveBeenCalledOnce()
  })

  it('calls requestApproval when autoApprove is absent', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    const tool = makeReadTool({ autoApprove: undefined })
    const set = buildAiTools([tool], hooks)
    await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(requestApproval).toHaveBeenCalledOnce()
  })

  it('auto-denies (fail-safe) when no requestApproval channel and autoApprove returns false', async () => {
    const hooks = makeHooks(undefined) // no channel
    const tool = makeReadTool({ autoApprove: async () => false })
    const set = buildAiTools([tool], hooks)
    const result = await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(result).toMatchObject({ denied: true })
  })

  it('auto-denies (fail-safe) when no requestApproval channel and autoApprove is absent', async () => {
    const hooks = makeHooks(undefined)
    const tool = makeReadTool({ autoApprove: undefined })
    const set = buildAiTools([tool], hooks)
    const result = await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(result).toMatchObject({ denied: true })
  })

  it('non-dangerous tools bypass the gate entirely', async () => {
    const requestApproval = vi.fn()
    const hooks = makeHooks(requestApproval)
    const tool = makeReadTool({ dangerous: false, autoApprove: undefined })
    const set = buildAiTools([tool], hooks)
    const result = await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(requestApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true })
  })
})

it('emits callId, args, result and kind on tool-result', async () => {
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'search_docs', description: 'd', schema: {}, kind: 'read',
    handler: async () => ({ result: { hits: 3 }, summary: 'found 3' })
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.search_docs!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
    { q: 'nuxt' }, { toolCallId: 'call_abc' }
  )

  const done = events.find(e => e.type === 'tool-result')!
  expect(done.callId).toBe('call_abc')
  expect(done.kind).toBe('read')
  expect(done.args).toEqual({ q: 'nuxt' })
  expect(done.result).toEqual({ hits: 3 })
})

it('emits a record for a FAILED tool so the agent sees the failure next turn', async () => {
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'web_fetch', description: 'd', schema: {}, kind: 'read',
    handler: async () => { throw new Error('boom') }
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.web_fetch!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 'call_err' })

  const done = events.find(e => e.type === 'tool-result')!
  expect(done.callId).toBe('call_err')
  expect(done.result).toEqual({ error: 'boom' })
})
