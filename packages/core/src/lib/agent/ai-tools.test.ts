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
    toolset: 'core',
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

  it('awaits an async describeApproval before requestApproval sees the resolved command (cycle 79, Task 4)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    const tool = makeReadTool({
      describeApproval: async (a) => {
        await Promise.resolve() // force a real microtask hop, not just a sync-resolved Promise
        return { tool: 'my_tool', command: `resolved:${a.val}`, proposedPattern: '' }
      },
    })
    const set = buildAiTools([tool], hooks)
    await (set['my_tool']!.execute as Function)({ val: 'x' }, {})
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolved:x', proposedPattern: '' }))
  })

  it('passes a fresh, server-minted approvalNonce to describeApproval — NOT the SDK toolCallId (cycle 79 review round 3, N1: gmail_send\'s TOCTOU pin keys on this, never on the SDK id)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    let seenNonce: string | undefined
    const tool = makeReadTool({
      describeApproval: async (_a, meta) => {
        seenNonce = meta.approvalNonce
        return { tool: 'my_tool', command: 'cmd', proposedPattern: '' }
      },
    })
    const set = buildAiTools([tool], hooks)
    await (set['my_tool']!.execute as Function)({ val: 'x' }, { toolCallId: 'call_xyz' })
    expect(seenNonce).toBeTruthy()
    expect(seenNonce).not.toBe('call_xyz') // never the SDK's own id
  })

  it('mints a DISTINCT approvalNonce for every execution, even when the SDK toolCallId is identical or empty across calls (cycle 79 review round 3, N1)', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    const seenNonces: string[] = []
    const tool = makeReadTool({
      describeApproval: async (_a, meta) => {
        seenNonces.push(meta.approvalNonce)
        return { tool: 'my_tool', command: 'cmd', proposedPattern: '' }
      },
    })
    const set = buildAiTools([tool], hooks)
    // Both calls carry the SAME (empty) SDK toolCallId — a degenerate/buggy provider
    // (openai-compatible backends have been observed to send `id: ""` or a reused id).
    await (set['my_tool']!.execute as Function)({ val: 'x' }, { toolCallId: '' })
    await (set['my_tool']!.execute as Function)({ val: 'y' }, { toolCallId: '' })
    expect(seenNonces).toHaveLength(2)
    expect(seenNonces[0]).toBeTruthy()
    expect(seenNonces[1]).toBeTruthy()
    expect(seenNonces[0]).not.toBe(seenNonces[1])
  })

  it('also exposes approvalNonce on the handler\'s ToolContext (matching what describeApproval saw), while callId keeps its SDK/UI-correlation role unchanged', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const hooks = makeHooks(requestApproval)
    let describedNonce: string | undefined
    let handlerNonce: string | undefined
    let handlerCallId: string | undefined
    const tool = makeReadTool({
      describeApproval: async (_a, meta) => { describedNonce = meta.approvalNonce; return { tool: 'my_tool', command: 'cmd', proposedPattern: '' } },
      handler: async (_a, ctx) => { handlerNonce = ctx.approvalNonce; handlerCallId = ctx.callId; return { result: { ok: true }, summary: 'done' } },
    })
    const set = buildAiTools([tool], hooks)
    await (set['my_tool']!.execute as Function)({ val: 'x' }, { toolCallId: 'call_abc' })
    expect(handlerCallId).toBe('call_abc') // unchanged: the SDK id, for UI correlation only
    expect(handlerNonce).toBeTruthy()
    expect(handlerNonce).toBe(describedNonce) // the SAME nonce describeApproval saw for this call
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

it('keeps display image URLs OUT of the model-facing result', async () => {
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'generate_image', description: 'd', schema: {}, kind: 'create',
    handler: async () => ({
      result: { ok: true, image_id: 'img1' },
      summary: 'made an image',
      display: { images: [{ url: '/api/images/img1' }] }
    })
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.generate_image!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 'c1' })

  const done = events.find(e => e.type === 'tool-result')!
  expect(JSON.stringify(done.result)).not.toMatch(/\/api\/images/)   // model-facing: no URL
  expect(JSON.stringify(done.images)).toMatch(/\/api\/images/)       // display channel: URL present
})

it('emits a record for a DENIED tool so a refused command is not re-proposed', async () => {
  // "A refused command isn't re-proposed" is one of the three motivations for structural
  // tool-history; a regression dropping callId here silently restores the original bug.
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'exec', description: 'd', schema: {}, kind: 'destructive', dangerous: true,
    handler: async () => ({ result: { ok: true }, summary: 'ran' })
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
    { command: 'rm -rf /' }, { toolCallId: 'call_denied' }
  )   // no requestApproval channel → fail-safe auto-deny

  const done = events.find(e => e.type === 'tool-result')!
  expect(done.callId).toBe('call_denied')
  expect(done.kind).toBe('destructive')
  expect(done.args).toEqual({ command: 'rm -rf /' })
  expect(done.result).toEqual({ denied: true })
})

it('masks args with redactForLog on BOTH the success and denial paths', async () => {
  // exec's input can contain a literal secret value; these args are persisted to
  // conversation_messages.tool_calls and shipped to the browser via msgToDTO.
  const mask = (t: Partial<Record<string, unknown>> = {}) => ({
    name: 'exec', description: 'd', schema: {}, kind: 'destructive', dangerous: true,
    redactForLog: async (i: Record<string, unknown>) => ({ ...i, command: String(i.command).replace('hunter2', '***') }),
    handler: async () => ({ result: { ok: true }, summary: 'ran' }), ...t
  })
  const input = { command: 'curl -H "token: hunter2" https://x' }

  const denied: Record<string, unknown>[] = []
  const denySet = buildAiTools([mask() as never], { signal: new AbortController().signal, onEvent: e => denied.push(e as never) })
  await (denySet.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'c_deny' })
  const deniedEvent = denied.find(e => e.type === 'tool-result')!
  expect(JSON.stringify(deniedEvent.args)).not.toContain('hunter2')
  expect(JSON.stringify(deniedEvent.args)).toContain('***')

  const ok: Record<string, unknown>[] = []
  const okSet = buildAiTools([mask({ autoApprove: async () => true }) as never], { signal: new AbortController().signal, onEvent: e => ok.push(e as never) })
  await (okSet.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'c_ok' })
  for (const e of ok) expect(JSON.stringify(e.args)).not.toContain('hunter2')   // tool-start AND tool-result
  expect(JSON.stringify(ok.find(e => e.type === 'tool-result')!.args)).toContain('***')

  // …while the HANDLER still receives the unmasked input (masking is record-only).
  const seen: unknown[] = []
  const rawSet = buildAiTools([mask({ autoApprove: async () => true, handler: async (i: unknown) => { seen.push(i); return { result: {}, summary: 's' } } }) as never],
    { signal: new AbortController().signal, onEvent: () => {} })
  await (rawSet.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'c_raw' })
  expect(JSON.stringify(seen)).toContain('hunter2')
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
