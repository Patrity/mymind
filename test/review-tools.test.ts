// test/review-tools.test.ts — list_reviews / decide_review wiring (cycle 76, Task 9). No DB: the
// feed is stubbed and decideReview is a spy, so these prove the tool surface (registries, MCP,
// headless gate, approval gate) rather than the decisions themselves (review-decisions.db.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const feed = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('../server/services/review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/services/review')>()),
  listReviewFeed: vi.fn(async () => feed.items)
}))
const decide = vi.hoisted(() => vi.fn())
vi.mock('../server/services/review-decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/services/review-decisions')>()),
  decideReview: decide
}))

import { listReviewsTool, decideReviewTool } from '../server/lib/agent/tools/reviews'
import { agentTools } from '../server/lib/agent/tools'
import { bridgetProfile } from '../server/lib/agent/profile'
import { mcpToolNames } from '../server/lib/mcp/server'
import { classifyForHeadless, headlessTools } from '../server/lib/agent/runtime/gate'
import { buildAiTools } from '../server/lib/agent/ai-tools'

const ctx = { signal: new AbortController().signal }
const at = new Date('2026-09-30T10:00:00Z')
const CONFLICT_ID = '11111111-1111-4111-8111-111111111111'
const IMPROVEMENT_ID = '22222222-2222-4222-8222-222222222222'
const MEMORY_ID = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  decide.mockReset()
  feed.items = [
    { id: CONFLICT_ID, docId: null, kind: 'memory-supersede', proposed: { newId: 'n', existingId: 'e', newContent: 'Tony uses pnpm', existingContent: 'Tony uses npm' }, createdAt: at, docPath: null },
    {
      id: IMPROVEMENT_ID, docId: null, kind: 'self-improvement', createdAt: at, docPath: null,
      proposed: { proposal: { kind: 'skill.edit', target: 'weekly-report', content: 'new', reason: 'Tony asked for bullets', confidence: 0.9, evidence: ['three bullet points'] }, currentContent: 'old', reasons: ['tier'], jev: null, conversationId: 'c1' }
    },
    { id: MEMORY_ID, docId: null, kind: 'memory-unreviewed', proposed: { content: 'Tony likes tea', scope: 'user', tags: [], project: null, confidence: 0.5, jevScore: null }, createdAt: at, docPath: null }
  ]
})

describe('list_reviews', () => {
  it('returns every pending item with its choices from the shared registry', async () => {
    const { result } = await listReviewsTool.handler({ limit: 20 }, ctx)
    const items = (result as { items: { id: string, kind: string, summary: string, createdAt: string, choices: { id: string, label: string }[] }[] }).items
    expect(items.map(i => [i.kind, i.choices.map(c => c.id)])).toEqual([
      ['memory-supersede', ['keep-both', 'archive-old', 'archive-new', 'archive-both']],
      ['self-improvement', ['approve', 'reject']],
      ['memory-unreviewed', ['approve', 'reject']]
    ])
    expect(items[0]!.choices.map(c => c.label)).toContain('Archive old (accept)')
    expect(items[1]!.summary).toBe('skill.edit weekly-report: Tony asked for bullets')
    expect(items[1]!.createdAt).toBe(at.toISOString())
  })

  it('filters by kind and honours the limit', async () => {
    const byKind = await listReviewsTool.handler({ kind: 'self-improvement', limit: 20 }, ctx)
    expect((byKind.result as { items: { id: string }[] }).items.map(i => i.id)).toEqual([IMPROVEMENT_ID])
    const limited = await listReviewsTool.handler({ limit: 1 }, ctx)
    expect((limited.result as { items: unknown[] }).items).toHaveLength(1)
  })

  it('is read-class: in agentTools, on MCP, and runs in a headless run', () => {
    expect(listReviewsTool.kind).toBe('read')
    expect(agentTools).toContain(listReviewsTool)
    expect(mcpToolNames()).toContain('list_reviews')
    expect(classifyForHeadless(listReviewsTool)).toBe('run')
  })
})

describe('decide_review exposure', () => {
  it('is dangerous, absent from agentTools and MCP, and present on the Bridget profile', () => {
    expect(decideReviewTool.dangerous).toBe(true)
    expect(agentTools.map(t => t.name)).not.toContain('decide_review')
    expect(mcpToolNames()).not.toContain('decide_review')
    expect(bridgetProfile.tools).toContain(decideReviewTool)
  })

  it('is not allowlistable (confirmed every call); exec still is', async () => {
    const { execTool } = await import('../server/lib/agent/tools/exec')
    expect(decideReviewTool.allowlistable).not.toBe(true)
    expect(execTool.allowlistable).toBe(true)
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const set = buildAiTools([decideReviewTool], { signal: ctx.signal, onEvent: () => {}, requestApproval })
    await (set.decide_review as { execute: (i: unknown) => Promise<unknown> }).execute({ id: IMPROVEMENT_ID, choice: 'approve' })
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ tool: 'decide_review', allowlistable: false })
  })

  it('is excluded from headless runs — not even turned into a proposal', () => {
    expect(classifyForHeadless(decideReviewTool)).toBe('exclude')
    const tools = headlessTools(bridgetProfile.tools, { id: 'r', conversationId: 'c' }, async () => 'x')
    expect(tools.map(t => t.name)).not.toContain('decide_review')
    expect(tools.map(t => t.name)).toContain('list_reviews')
  })
})

describe('decide_review approval', () => {
  const run = (set: ReturnType<typeof buildAiTools>, args: unknown) =>
    (set.decide_review as { execute: (i: unknown) => Promise<unknown> }).execute(args)

  it('a denied confirmation never reaches the decision service', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const set = buildAiTools([decideReviewTool], { signal: ctx.signal, onEvent: () => {}, requestApproval })
    const res = await run(set, { id: IMPROVEMENT_ID, choice: 'approve' })
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ denied: true })
    expect(decide).not.toHaveBeenCalled()
  })

  it('no approval channel → auto-denied, nothing decided', async () => {
    const set = buildAiTools([decideReviewTool], { signal: ctx.signal, onEvent: () => {} })
    expect(await run(set, { id: IMPROVEMENT_ID, choice: 'approve' })).toEqual({ denied: true })
    expect(decide).not.toHaveBeenCalled()
  })

  it('the approval names the choice and the item summary cached by list_reviews (or the id)', async () => {
    expect(decideReviewTool.describeApproval!({ id: 'not-listed', choice: 'reject' }).command).toBe('reject — not-listed')
    await listReviewsTool.handler({ limit: 20 }, ctx)
    const req = decideReviewTool.describeApproval!({ id: IMPROVEMENT_ID, choice: 'approve' })
    expect(req).toMatchObject({ tool: 'decide_review', command: 'approve — skill.edit weekly-report: Tony asked for bullets' })
    // Nothing to "always allow": an empty pattern is never persisted.
    expect(req.proposedPattern).toBe('')
  })

  it('an approved call runs the decision and returns its result', async () => {
    decide.mockResolvedValue({ ok: true, summary: 'Improvement applied.' })
    const requestApproval = vi.fn().mockResolvedValue({ approved: true })
    const set = buildAiTools([decideReviewTool], { signal: ctx.signal, onEvent: () => {}, requestApproval })
    expect(await run(set, { id: IMPROVEMENT_ID, choice: 'approve' })).toEqual({ ok: true, summary: 'Improvement applied.', applied: undefined })
    expect(decide).toHaveBeenCalledWith(IMPROVEMENT_ID, 'approve')
  })

  it('never throws: a refusal and an unexpected error both come back as results', async () => {
    decide.mockResolvedValueOnce({ ok: false, reason: 'not_pending', message: 'already decided' })
    expect((await decideReviewTool.handler({ id: IMPROVEMENT_ID, choice: 'approve' }, ctx)).result)
      .toEqual({ ok: false, reason: 'not_pending', message: 'already decided' })
    decide.mockRejectedValueOnce(new Error('db down'))
    expect((await decideReviewTool.handler({ id: IMPROVEMENT_ID, choice: 'approve' }, ctx)).result)
      .toEqual({ ok: false, reason: 'error', message: 'Could not decide: db down' })
  })
})
