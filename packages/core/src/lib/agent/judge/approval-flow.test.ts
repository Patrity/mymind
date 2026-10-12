// Cycle 84 Task 2: Smart Approvals end to end through the REAL runAgent → buildAiTools → bus approval
// channel (fake model, fake judge seams): the run's surface decides; an auto-approved call executes and
// its tool record carries the "⚖ auto-approved" note; a chat run stays manual; headless never auto-runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/record', () => ({ recordEvent: vi.fn(), withSpan: (_s: unknown, fn: () => unknown) => fn() }))

import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { runAgent, type AgentEvent, type AgentMessage, type RunAgentCtx } from '../run'
import { busApprovalChannel, decideBusApproval, pendingBusApprovals } from '../runtime/bus-approvals'
import { approvalJudgeDeps, defaultApprovalJudgeDeps } from './approval'
import type { AgentTool } from '../types'
import type { JudgeSettings, JudgeVerdict } from './types'
import type { JudgeInput } from './verdict'

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
const finish = (r: 'tool-calls' | 'stop') => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })

const ran: string[] = []
const rsvp: AgentTool = {
  name: 'calendar_rsvp', description: 'RSVP to an event', kind: 'create', toolset: 'calendar', dangerous: true,
  schema: { eventId: z.string() },
  describeApproval: a => ({ tool: 'calendar_rsvp', title: 'Send RSVP?', command: `RSVP accepted to ${String(a.eventId)}`, proposedPattern: '' }),
  handler: async (a) => { ran.push(a.eventId as string); return { result: { ok: true }, summary: 'rsvp sent' } }
}
const ON: JudgeSettings = { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 }
const APPROVE: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 0.96, reasons: ['matches the goal'], model: 'J', latencyMs: 3 }
const judged: JudgeInput[] = []

beforeEach(() => {
  ran.length = 0
  judged.length = 0
  Object.assign(approvalJudgeDeps, {
    settings: async () => ON,
    freshSettings: async () => ON,
    rule: async () => ({ floor: 'review', reasons: [] }),
    verdict: async (i: JudgeInput) => { judged.push(i); return APPROVE },
    recordVerdict: async () => {},
    recordDecision: async () => true,
    ruleContextWaitMs: 10
  })
})
afterEach(() => {
  Object.assign(approvalJudgeDeps, defaultApprovalJudgeDeps)
  for (const id of pendingBusApprovals()) decideBusApproval({ requestId: id, approved: false })
})

async function run(ctx: Partial<RunAgentCtx>, history: AgentMessage[] = []): Promise<AgentEvent[]> {
  const steps = [[call('c1', 'calendar_rsvp', { eventId: 'standup' }), finish('tool-calls')], [...text('done'), finish('stop')]]
  let i = 0
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream(steps[Math.min(i++, steps.length - 1)]! as never) }) })
  const events: AgentEvent[] = []
  for await (const e of runAgent([...history, { role: 'user', content: 'accept the standup invite' }], { signal: new AbortController().signal, maxSteps: 4, runId: 'run-f', ...ctx },
    { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools: [rsvp], buildSystemPrompt: async () => 's' })) events.push(e)
  return events
}
const chan = (signal?: AbortSignal) => busApprovalChannel('run-f', { publish: () => {}, timeoutMs: null, signal })
const toolResult = (events: AgentEvent[]) => events.find(e => e.type === 'tool-result') as Extract<AgentEvent, { type: 'tool-result' }> | undefined

describe('Smart Approvals through runAgent', () => {
  it('a workstream segment: the judge approves, the call EXECUTES, and its record carries the ⚖ note', async () => {
    const events = await run({
      requestApproval: chan(),
      workstream: { goal: 'tidy my calendar', used: { steps: 0, wallMs: 0 }, budget: { maxSteps: 10, maxWallMs: 60_000 } },
      approvals: { surface: 'workstream', workstreamId: 'ws-9' }
    }, [{ role: 'assistant', content: 'earlier reply' }])
    expect(ran).toEqual(['standup'])
    expect(toolResult(events)).toMatchObject({ name: 'calendar_rsvp', result: { ok: true }, approval: { decidedBy: 'judge', confidence: 0.96, reason: 'matches the goal' } })
    // The judge read the card, the workstream's goal and the conversation so far.
    expect(judged[0]).toMatchObject({ tool: 'calendar_rsvp', call: 'Send RSVP?\nRSVP accepted to standup', goal: 'tidy my calendar' })
    expect(judged[0]!.recentMessages).toEqual([{ role: 'assistant', text: 'earlier reply' }, { role: 'user', text: 'accept the standup invite' }])
  })

  it('the surface is derived when the caller gives none: a workstream ctx is a workstream', async () => {
    await run({ requestApproval: chan(), workstream: { goal: 'g', used: { steps: 0, wallMs: 0 }, budget: { maxSteps: 10, maxWallMs: 60_000 } } })
    expect(ran).toEqual(['standup'])
  })

  it('a chat run stays manual by default — denied by Tony, nothing runs, no note', async () => {
    const p = run({ requestApproval: chan(), approvals: { surface: 'chat' } })
    for (let i = 0; i < 50 && !pendingBusApprovals('run-f').length; i++) await new Promise(r => setTimeout(r, 5))
    await new Promise(r => setTimeout(r, 20))                   // the verdict has landed: still waiting
    expect(pendingBusApprovals('run-f')).toHaveLength(1)
    decideBusApproval({ requestId: pendingBusApprovals('run-f')[0]!, approved: false })
    const events = await p
    expect(ran).toEqual([])
    expect(toolResult(events)).toMatchObject({ result: { denied: true } })
    expect(toolResult(events)!.approval).toBeUndefined()
  })

  it('M3: no surface given and no workstream → headless (fail closed), even with chat switched on', async () => {
    Object.assign(approvalJudgeDeps, { settings: async () => ({ ...ON, smartApprovals: { workstreams: true, chat: true } }), freshSettings: async () => ({ ...ON, smartApprovals: { workstreams: true, chat: true } }) })
    const p = run({ requestApproval: chan() })
    await new Promise(r => setTimeout(r, 50))
    expect(judged).toHaveLength(1)
    expect(ran).toEqual([])
    decideBusApproval({ requestId: pendingBusApprovals('run-f')[0]!, approved: false })
    await p
  })

  it('a wake (headless) never auto-runs, even with every switch on', async () => {
    Object.assign(approvalJudgeDeps, { settings: async () => ({ ...ON, smartApprovals: { workstreams: true, chat: true } }), freshSettings: async () => ({ ...ON, smartApprovals: { workstreams: true, chat: true } }) })
    const ac = new AbortController()
    const p = run({ requestApproval: chan(ac.signal), wake: { reason: 'check' }, signal: ac.signal })
    await new Promise(r => setTimeout(r, 50))
    expect(judged).toHaveLength(1)
    expect(ran).toEqual([])
    expect(pendingBusApprovals('run-f')).toHaveLength(1)
    decideBusApproval({ requestId: pendingBusApprovals('run-f')[0]!, approved: false })
    await p
    expect(ran).toEqual([])
  })

  it('no approval channel → no judge at all (denied as before)', async () => {
    const verdict = vi.fn(async () => APPROVE)
    Object.assign(approvalJudgeDeps, { verdict })
    await run({})
    expect(ran).toEqual([])
    expect(verdict).not.toHaveBeenCalled()
  })
})
