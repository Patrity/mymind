// Cycle 79b (d): per-call headless proposal. A tool classified `run` may declare
// `proposeWhen(args)`; in a headless run a call for which it is true becomes a /review proposal
// (handler NOT called), any other call runs as before. Approving the proposal replays the REAL
// handler — proposeWhen is a headless-gate concern only.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@mymind/core/lib/observability/record', () => ({ withSpan: (_m: unknown, fn: () => unknown) => fn(), recordEvent: () => {} }))
vi.mock('@mymind/core/lib/agent/bus', () => ({ publishActivity: () => {} }))

import { classifyForHeadless, headlessTools, type AgentActionProposal } from '@mymind/core/lib/agent/runtime/gate'
import { replayAgentAction } from '@mymind/core/lib/agent/runtime/replay'
import { gmailTools } from '@mymind/core/lib/agent/tools/gmail'
import type { AgentTool } from '@mymind/core/lib/agent/types'

const realDraft = gmailTools.find(t => t.name === 'gmail_draft')!
const ARGS = { account: 'work', to: ['bob@example.com'], subject: 's', body: 'b' }

function setup() {
  const handler = vi.fn(async (a: Record<string, unknown>) => ({ result: { draftId: a.draftId ?? 'new-1' }, summary: 'drafted' }))
  const tool: AgentTool = { ...realDraft, handler }
  const proposals: AgentActionProposal[] = []
  const [gated] = headlessTools([tool], { id: 'run-1', conversationId: 'conv-1' }, async (p) => { proposals.push(p); return 'rev-1' })
  return { tool, gated: gated!, handler, proposals }
}
const ctx = { signal: new AbortController().signal }

describe('proposeWhen (79b d)', () => {
  it('gmail_draft stays classified `run` and declares proposeWhen on draftId', () => {
    expect(classifyForHeadless(realDraft)).toBe('run')
    expect(realDraft.proposeWhen?.({ ...ARGS, draftId: 'd1' })).toBe(true)
    expect(realDraft.proposeWhen?.(ARGS)).toBe(false)
  })

  it('headless gmail_draft WITH draftId → proposal created, handler not called', async () => {
    const { gated, handler, proposals } = setup()
    const out = await gated.handler({ ...ARGS, draftId: 'd1' }, ctx)
    expect(handler).not.toHaveBeenCalled()
    expect(proposals).toEqual([{ runId: 'run-1', conversationId: 'conv-1', tool: 'gmail_draft', args: { ...ARGS, draftId: 'd1' } }])
    expect(out.result).toEqual({ proposed: true, reviewId: 'rev-1', note: "Queued for Tony's approval in /review." })
  })

  it('headless gmail_draft WITHOUT draftId → runs the handler, no proposal', async () => {
    const { gated, handler, proposals } = setup()
    const out = await gated.handler(ARGS, ctx)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(proposals).toEqual([])
    expect(out.result).toEqual({ draftId: 'new-1' })
  })

  it('approving the proposal replays the REAL handler (proposeWhen is ignored on replay)', async () => {
    const { tool, gated, handler, proposals } = setup()
    await gated.handler({ ...ARGS, draftId: 'd1' }, ctx)
    const p = proposals[0]!
    const r = await replayAgentAction({ tool: p.tool, args: p.args }, { tools: [tool] })
    expect(r).toEqual({ ok: true, summary: 'drafted', undoToken: undefined })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({ draftId: 'd1' })
  })

  it('a tool with no proposeWhen is untouched by the wrapper', () => {
    const plain: AgentTool = { name: 'search_memories', description: '', kind: 'read', toolset: 'memory', schema: {}, handler: async () => ({ result: 1, summary: '' }) }
    const [out] = headlessTools([plain], { id: 'r', conversationId: 'c' }, async () => 'x')
    expect(out).toBe(plain)
  })
})
