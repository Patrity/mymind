// test/ai-tools-gate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildAiTools } from '../server/lib/agent/ai-tools'
import type { AgentTool } from '../server/lib/agent/types'
import { z } from 'zod'

function dangerTool(): AgentTool {
  return {
    name: 'exec', description: 'x', kind: 'destructive', dangerous: true,
    schema: { command: z.string() },
    describeApproval: (a) => ({ tool: 'exec', command: a.command as string, proposedPattern: 'echo *' }),
    handler: async (a) => ({ result: { ran: a.command }, summary: 'ran' })
  }
}
const exec = (set: ReturnType<typeof buildAiTools>, args: unknown) =>
  // AI SDK tool exposes execute(input, ctx?) — call it directly for the test.
  (set.exec as { execute: (i: unknown) => Promise<unknown> }).execute(args)

describe('buildAiTools dangerous-tool gate', () => {
  it('runs the handler when approval is granted', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const set = buildAiTools([dangerTool()], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
    const res = await exec(set, { command: 'echo hi' })
    expect(requestApproval).toHaveBeenCalledWith({ tool: 'exec', command: 'echo hi', proposedPattern: 'echo *', allowlistable: false, callId: '', args: { command: 'echo hi' } })
    expect(res).toEqual({ ran: 'echo hi' })
  })
  it('the request carries the MASKED args (the ones tool-start records), never the raw input', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const t = dangerTool(); t.redactForLog = async () => ({ command: 'echo ***' })
    await exec(buildAiTools([t], { signal: new AbortController().signal, onEvent: () => {}, requestApproval }), { command: 'echo secret' })
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ args: { command: 'echo ***' } })
  })
  it('the request carries allowlistable from the TOOL, never from describeApproval', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const allow = dangerTool(); allow.allowlistable = true
    await exec(buildAiTools([allow], { signal: new AbortController().signal, onEvent: () => {}, requestApproval }), { command: 'echo hi' })
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ allowlistable: true })
    const spoof = dangerTool()
    spoof.describeApproval = a => ({ tool: 'exec', command: a.command as string, proposedPattern: 'echo *', allowlistable: true })
    await exec(buildAiTools([spoof], { signal: new AbortController().signal, onEvent: () => {}, requestApproval }), { command: 'echo hi' })
    expect(requestApproval.mock.calls[1]![0]).toMatchObject({ allowlistable: false })
  })
  it('skips the handler and returns a denied result when denied', async () => {
    const handler = vi.fn()
    const t = dangerTool(); t.handler = handler as never
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const set = buildAiTools([t], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
    const res = await exec(set, { command: 'echo hi' })
    expect(handler).not.toHaveBeenCalled()
    expect(res).toEqual({ denied: true })
  })
  it('auto-denies (fail-safe) when no requestApproval channel is present', async () => {
    const handler = vi.fn()
    const t = dangerTool(); t.handler = handler as never
    const set = buildAiTools([t], { signal: new AbortController().signal, onEvent: () => {} })
    const res = await exec(set, { command: 'echo hi' })
    expect(handler).not.toHaveBeenCalled()
    expect(res).toEqual({ denied: true })
  })
  it('denies when approval resolves to a non-true (malformed) value', async () => {
    const handler = vi.fn()
    const t = dangerTool(); t.handler = handler as never
    const requestApproval = vi.fn().mockResolvedValue({ approved: 'yes' as unknown as boolean })
    const set = buildAiTools([t], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
    const res = await exec(set, { command: 'echo hi' })
    expect(handler).not.toHaveBeenCalled()
    expect(res).toEqual({ denied: true })
  })
  it('does not gate a non-dangerous tool', async () => {
    const t: AgentTool = { name: 'ping', description: 'x', kind: 'read', schema: {}, handler: async () => ({ result: 'pong', summary: 'p' }) }
    const requestApproval = vi.fn()
    const set = buildAiTools([t], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
    const res = await (set.ping as { execute: (i: unknown) => Promise<unknown> }).execute({})
    expect(requestApproval).not.toHaveBeenCalled()
    expect(res).toBe('pong')
  })
})
