// Pure render helpers for the agent conversation — kept out of the SFCs so they are testable
// without mounting components.
import type { AgentUIMessage, AgentUIPart, SubagentStep } from '~~/shared/types/agent-ui'
import type { MessageUsage } from '~~/shared/types/conversation'

export function uiMessageText(m: AgentUIMessage): string {
  return m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
}

export function subagentSteps(m: AgentUIMessage, toolCallId: string): SubagentStep[] | null {
  const part = m.parts.find(p => p.type === 'data-subagent' && p.id === toolCallId)
  return part && part.type === 'data-subagent' ? part.data.steps : null
}

/** Absent usage renders nothing rather than a misleading zero. */
export function tokenLabel(usage?: MessageUsage | null): string {
  const t = usage?.totalTokens
  if (typeof t !== 'number' || t <= 0) return ''
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`
}

export function toolTitle(name: string): string {
  const s = name.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function isRunning(p: AgentUIPart): boolean {
  return p.type === 'dynamic-tool' && (p.state === 'input-streaming' || p.state === 'input-available')
}
