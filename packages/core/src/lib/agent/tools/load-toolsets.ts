// Cycle 78: Bridget loads on-demand toolsets herself. Lives in bridgetProfile (not agentTools),
// so /api/mcp never exposes it — MCP clients already see every tool.
import { z } from 'zod'
import type { AgentTool } from '../types'
import { ON_DEMAND_TOOLSETS, TOOLSETS, type ToolsetId } from '../toolsets'

export const loadToolsetsTool: AgentTool = {
  name: 'load_toolsets',
  toolset: 'core',
  kind: 'read',
  description: 'Make on-demand toolsets available from your next step on (see the TOOLSETS list in your instructions). They stay loaded for the rest of this conversation.',
  schema: { ids: z.array(z.enum(ON_DEMAND_TOOLSETS as [ToolsetId, ...ToolsetId[]])).min(1) },
  handler: async (args, ctx) => {
    const ids = args.ids as ToolsetId[]
    const added = ctx.loadToolsets?.(ids) ?? []
    const names = ids.map(id => `${id} (${TOOLSETS[id].description})`).join(', ')
    // Cycle 83 fix round 1 (M5): a top-level workstream that loads `coordinator` gets its rules at once
    // (the system prompt carries them from its next segment on).
    let instructions: string | undefined
    if (ids.includes('coordinator')) {
      const seg = (await import('../workstreams/loop')).segmentForRun(ctx.runId)
      if (seg && !seg.child) instructions = (await import('../prompt')).COORDINATOR_RULES.join('\n')
    }
    return { result: { loaded: ids, newlyLoaded: added, ...(instructions ? { instructions } : {}) }, summary: `loaded ${names}` }
  }
}
