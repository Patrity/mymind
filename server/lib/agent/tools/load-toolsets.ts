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
    return { result: { loaded: ids, newlyLoaded: added }, summary: `loaded ${names}` }
  }
}
