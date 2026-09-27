// server/lib/agent/runtime/history.ts
// History reaches the model as STRUCTURED messages (tool-call/tool-result blocks via
// buildModelMessages), exactly as before. The assembler only decides HOW MANY trailing turns
// survive the budget; these helpers cost the turns and slice the array to match.
import { tier, type Tier } from '../budget'
import { estimateTokens } from '../../chunking/chunk-markdown'
import type { AgentMessage } from '../run'
import { messageText } from '../run'

export const RUNTIME_CONTEXT_BUDGET = 20_000
export const RECENT_THREADS_MAX_TOKENS = 600
export const MAIN_STATE_MAX_TOKENS = 300

export function groupTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = []
  for (const m of messages) {
    const last = turns[turns.length - 1]
    // A turn starts at every user-role message. Slicing at a user boundary can never separate
    // an assistant message from its own tool blocks, which is the only invariant budgeting needs.
    if (m.role === 'user' || !last) turns.push([m])
    else last.push(m)
  }
  return turns
}

export function turnTier(turn: AgentMessage[], index: number): Tier {
  const text = turn.map((m) => {
    const records = (m as { toolRecords?: { args?: unknown; result?: unknown }[] }).toolRecords ?? []
    const tools = records.map(r => JSON.stringify(r.args ?? {}) + JSON.stringify(r.result ?? '')).join(' ')
    return `${messageText(m.content)} ${tools}`
  }).join(' ')
  return tier(`turn:${index}`, text)
}

export function keepTrailingTurns(turns: AgentMessage[][], keep: number): AgentMessage[] {
  if (keep <= 0) return []
  return turns.slice(-keep).flat()
}

export function capToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid) + '…') <= maxTokens) lo = mid; else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
