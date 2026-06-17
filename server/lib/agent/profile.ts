// server/lib/agent/profile.ts
import { agentTools } from './tools'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// The only profile this cycle. The shape is the seam for Cycle B (powerful tools).
export const bridgetProfile: AgentProfile = { id: 'bridget', tools: agentTools, personaKey: 'agent_persona' }
