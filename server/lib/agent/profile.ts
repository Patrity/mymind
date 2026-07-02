// server/lib/agent/profile.ts
import { agentTools } from './tools'
import { execTool } from './tools/exec'
import { subagentTools } from './subagents'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// ONE always-armed profile. The old bridget/powerful split + exec cookie are
// gone (Tony, 2026-07-01): exec and the subagents are always available; safety
// is the approval gate (exec stays dangerous:true → allowlist-or-approve, and
// auto-denies on channels with no approval UI, e.g. headless SSE/MCP).
// exec + subagents live HERE, not in agentTools, so the MCP surface never
// exposes them.
export const bridgetProfile: AgentProfile = {
  id: 'bridget',
  tools: [...agentTools, execTool, ...subagentTools],
  personaKey: 'agent_persona'
}
