// server/lib/agent/runtime/history.ts
// History reaches the model as STRUCTURED messages (tool-call/tool-result blocks via
// buildModelMessages), exactly as before. The assembler only decides HOW MANY trailing turns
// survive the budget; these helpers cost the turns and slice the array to match.
import { tier, type Tier } from '../budget'
import { estimateTokens } from '../../chunking/chunk-markdown'
import type { AgentMessage } from '../run'
import { messageText } from '../run'
import { applyHistoryPolicy } from '../tool-history'

export const RUNTIME_CONTEXT_BUDGET = 20_000
export const RECENT_THREADS_MAX_TOKENS = 600
export const MAIN_STATE_MAX_TOKENS = 300
/** `context: 'light'` runs (cycle 74 jobs) see only this many trailing turns of verbatim history
 *  — after the summary tier, which still applies (getAgentHistory is already since-summary). */
export const LIGHT_CONTEXT_TURNS = 4

export function groupTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = []
  let prev: AgentMessage | undefined
  for (const m of messages) {
    const last = turns[turns.length - 1]
    // A turn starts at a user-role message that follows a NON-user message (or at the first
    // message). Slicing at such a boundary can never separate an assistant message from its own
    // tool blocks, which budgeting needs. A user row right after another user row JOINS the
    // turn: that is a steer (runner.ts persists [question, steer…, reply] in ONE append, so the
    // rows share one created_at). Splitting there let summarize.ts fold through the question
    // and set summarized_through to that shared created_at — and sinceSummary's `>` then hid the
    // steer and reply from the model without them ever being summarised. Events map to user
    // role, so [event, steer…, reply] stays whole too. The only other user→user adjacency is a
    // turn that got no reply followed by the next question; merging those is harmless.
    if (!last || (m.role === 'user' && prev?.role !== 'user')) turns.push([m])
    else last.push(m)
    prev = m
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

/**
 * Cost every turn as the model will actually SEE it. buildModelMessages (run.ts) runs
 * applyHistoryPolicy before expanding tool records — read results capped, out-of-window
 * payloads elided — so pricing the raw persisted payloads over-charged a tool-heavy turn by an
 * order of magnitude (8 web_fetch results of 8k chars priced ~17k tokens but reach the model
 * as ~3k), and one such turn made fitBudget keep ZERO history (final review C2). The policy is
 * applied over the WHOLE history, newest-first, exactly as buildModelMessages will apply it to
 * the kept tail: its tool window counts from the newest message, so dropping older turns never
 * changes how a kept turn is represented.
 */
export function costTurns(turns: AgentMessage[][]): Tier[] {
  const policed = applyHistoryPolicy(turns.flat())
  let at = 0
  return turns.map((t, i) => {
    const slice = policed.slice(at, at + t.length)
    at += t.length
    return turnTier(slice, i)
  })
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
