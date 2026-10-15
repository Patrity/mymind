import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool, ToolContext } from '../types'

vi.mock('../../observability/record', () => ({ withSpan: (_m: unknown, fn: () => unknown) => fn(), recordEvent: () => {} }))
vi.mock('../bus', () => ({ publishActivity: () => {} }))

import { replayAgentAction } from './replay'

describe('replayAgentAction ctx', () => {
  it('marks the handler ctx as a replay (tools honour pinned ids only then)', async () => {
    let seen: ToolContext | undefined
    const t: AgentTool = { name: 'x', description: 'd', kind: 'create', toolset: 'core', schema: { a: z.string().optional() }, handler: async (_a, ctx) => { seen = ctx; return { result: {}, summary: 's' } } }
    const r = await replayAgentAction({ tool: 'x', args: {} }, { tools: [t] })
    expect(r.ok).toBe(true)
    expect(seen?.replay).toBe(true)
    expect(seen?.runId).toBeUndefined()
  })
})
