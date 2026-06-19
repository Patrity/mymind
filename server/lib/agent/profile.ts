// server/lib/agent/profile.ts
import { agentTools } from './tools'
import { execTool } from './tools/exec'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// Default safe profile — unchanged (no dangerous tools).
export const bridgetProfile: AgentProfile = { id: 'bridget', tools: agentTools, personaKey: 'agent_persona' }

// Opt-in powerful profile — the safe toolset PLUS the gated exec tool.
export const powerfulProfile: AgentProfile = { id: 'powerful', tools: [...agentTools, execTool], personaKey: 'agent_persona' }

export function profileById(id: string | undefined): AgentProfile {
  return id === 'powerful' ? powerfulProfile : bridgetProfile
}
