// server/lib/agent/profile.ts
import { agentTools } from './tools'
import { decideReviewTool } from './tools/reviews'
import { subagentTools } from './subagents'
import { loadToolsetsTool } from './tools/load-toolsets'
import { googleDangerousTools } from './tools/gmail'
import { calendarDangerousTools } from './tools/calendar'
import { answerWorkstreamTool, startWorkstreamTool, workstreamOnlyTools } from './tools/workstreams'
import { exportToCoordinatorTool, workspaceTools } from './tools/workspace'
import { coordinatorTools, spawnToolWithModels, spawnWorkstreamsTool } from './tools/coordinator'
import type { SubagentModelInfo } from '../ai/registry/resolve'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// ONE profile; every tool in it is always AVAILABLE. The old bridget/powerful split is gone
// (Tony, 2026-07-01); safety is the approval gate. Host `exec` and its `admin` toolset are gone too
// (cycle 86): the workspace IS Bridget's own Mac now.
// The subagents live HERE, not in agentTools, so the MCP surface never exposes them. decide_review (cycle 76) likewise: dangerous, confirmed per call, and never on
// MCP or in a headless run. load_toolsets (cycle 78) lives here too: on-demand toolsets only
// change which tools the model SEES per step, never which it can call; MCP clients see all.
// googleDangerousTools (cycle 79 review, I1): gmail_send — and calendarDangerousTools (Task 5):
// calendar_guest_event / calendar_rsvp — live here for the same reason: every agentTools consumer (MCP, replay,
// subagents, toolByName) is otherwise one forgotten `dangerous` check away from a gateless send.
// They keep `toolset: 'gmail'`/`'calendar'` — toolset visibility runs over bridgetProfile.tools
// (run.ts), not agentTools, so on-demand loading still works from here.
export const bridgetProfile: AgentProfile = {
  id: 'bridget',
  // workspaceTools (cycle 82/86): Bridget's own Mac — profile-only, so MCP never sees them.
  tools: [...agentTools, ...subagentTools, decideReviewTool, ...googleDangerousTools, ...calendarDangerousTools, loadToolsetsTool, startWorkstreamTool, answerWorkstreamTool, ...workspaceTools],
  personaKey: 'agent_persona'
}

/** Cycle 81 (spec §5.3): a workstream segment's registry — Bridget's tools WITHOUT start_workstream
 *  and answer_workstream (Bridget's, for Tony's answers), plus finish_workstream and ask_tony, which
 *  exist only here. Same persona; interactive (approvals wait on Tony — workstreams/loop.ts).
 *  Cycle 83: a TOP-LEVEL workstream also has the on-demand `coordinator` toolset (it fans out by
 *  spawning children, not by start_workstream). Chat never has it (D10). */
export const workstreamProfile: AgentProfile = {
  id: 'workstream',
  tools: [...bridgetProfile.tools.filter(t => t.name !== startWorkstreamTool.name && t.name !== answerWorkstreamTool.name), ...workstreamOnlyTools, ...coordinatorTools],
  personaKey: 'agent_persona'
}

/** Cycle 83 (D2, depth 1): a CHILD workstream's registry — no `coordinator` toolset; it can hand files
 *  up with export_to_coordinator (workspace toolset; refused unless its workspace is its own). */
export const childWorkstreamProfile: AgentProfile = {
  id: 'workstream-child',
  tools: [...workstreamProfile.tools.filter(t => t.toolset !== 'coordinator'), exportToCoordinatorTool],
  personaKey: 'agent_persona'
}

/** A top-level segment's registry with the CURRENT `subagents` models in spawn_workstreams'
 *  description (labels + descriptions — the coordinator picks a model per child by them). */
export function coordinatorProfile(models: SubagentModelInfo[]): AgentProfile {
  const spawn = spawnToolWithModels(models)
  return { ...workstreamProfile, tools: workstreamProfile.tools.map(t => t.name === spawnWorkstreamsTool.name ? spawn : t) }
}

/** Cycle 79b fix round 1 (I1): every `taints` tool Bridget has, dangerous ones included. The
 *  cross-turn taint seed (run.ts) recognises history records by THIS fixed list, never by the
 *  run's own registry — a headless registry (runtime/gate.ts headlessTools) drops the dangerous
 *  tools, so calendar_rsvp / calendar_guest_event results in history would otherwise go unseen. */
export const TAINTING_TOOL_NAMES: ReadonlySet<string> = new Set(bridgetProfile.tools.filter(t => t.taints).map(t => t.name))
