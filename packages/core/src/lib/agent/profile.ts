// server/lib/agent/profile.ts
import { agentTools } from './tools'
import { execTool } from './tools/exec'
import { decideReviewTool } from './tools/reviews'
import { subagentTools } from './subagents'
import { loadToolsetsTool } from './tools/load-toolsets'
import { googleDangerousTools } from './tools/gmail'
import { calendarDangerousTools } from './tools/calendar'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// ONE profile; every tool in it is always AVAILABLE. The old bridget/powerful split + exec
// cookie are gone (Tony, 2026-07-01): exec and the subagents are always available; safety
// is the approval gate (exec stays dangerous:true → allowlist-or-approve, and
// auto-denies on channels with no approval UI, e.g. headless SSE/MCP).
// exec + subagents live HERE, not in agentTools, so the MCP surface never
// exposes them. decide_review (cycle 76) likewise: dangerous, confirmed per call, and never on
// MCP or in a headless run. load_toolsets (cycle 78) lives here too: on-demand toolsets only
// change which tools the model SEES per step, never which it can call; MCP clients see all.
// googleDangerousTools (cycle 79 review, I1): gmail_send — and calendarDangerousTools (Task 5):
// calendar_guest_event / calendar_rsvp — live here for the same reason: every agentTools consumer (MCP, replay,
// subagents, toolByName) is otherwise one forgotten `dangerous` check away from a gateless send.
// They keep `toolset: 'gmail'`/`'calendar'` — toolset visibility runs over bridgetProfile.tools
// (run.ts), not agentTools, so on-demand loading still works from here.
export const bridgetProfile: AgentProfile = {
  id: 'bridget',
  tools: [...agentTools, execTool, ...subagentTools, decideReviewTool, ...googleDangerousTools, ...calendarDangerousTools, loadToolsetsTool],
  personaKey: 'agent_persona'
}

/** Cycle 79b fix round 1 (I1): every `taints` tool Bridget has, dangerous ones included. The
 *  cross-turn taint seed (run.ts) recognises history records by THIS fixed list, never by the
 *  run's own registry — a headless registry (runtime/gate.ts headlessTools) drops the dangerous
 *  tools, so calendar_rsvp / calendar_guest_event results in history would otherwise go unseen. */
export const TAINTING_TOOL_NAMES: ReadonlySet<string> = new Set(bridgetProfile.tools.filter(t => t.taints).map(t => t.name))
