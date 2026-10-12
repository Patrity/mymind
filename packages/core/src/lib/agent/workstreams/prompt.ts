// Cycle 81 (spec §5.2): what a workstream says to its model besides the system-prompt block
// (lib/agent/prompt.ts workstreamBlock). Each segment starts from one of these, persisted as an
// EVENT row (origin `segment:<why>`) — never as words Tony said. Plain sentences, no markers: the
// model imitates whatever its history looks like.
import type { WorkstreamPromptInfo } from '../prompt'
import type { WorkstreamRow } from './store'
import { budgetOf, usedOf } from './store'

export type SegmentWhy = 'start' | 'continue' | 'restarted' | 'retry' | 'budget' | 'idle' | 'watch' | 'children'

export function segmentOrigin(why: SegmentWhy): string { return `segment:${why}` }

export function segmentText(why: SegmentWhy, ws: Pick<WorkstreamRow, 'goal'>, detail?: string): string {
  switch (why) {
    case 'start': return `Goal: ${ws.goal}\nStart working on it.`
    case 'continue': return 'Continue working on the goal. If it is complete, call finish_workstream with a summary.'
    case 'restarted': return 'The agent worker restarted. Continue working on the goal from where the log above leaves off.'
    case 'retry': return `The previous segment failed${detail ? ` (${detail})` : ''}. Continue working on the goal, taking a different approach if needed.`
    case 'idle': return 'You made no tool calls in the last segment. If the goal is complete, call finish_workstream with a summary now; otherwise continue working with your tools.'
    case 'budget': return `The workstream is stopping: ${detail ?? 'its budget is used up'}. Write the final summary now.`
    // Cycle 82: the watch results (sandbox/watches.ts watchText) — continue from them.
    case 'watch': return `${detail ?? 'A watch you set has ended.'}\nContinue working on the goal.`
    // Cycle 83: a coordinator woken from wait_for_workstreams (coordinator.ts childReport).
    case 'children': return `${detail ?? 'Your child workstreams have news.'}\nContinue: answer questions with answer_child, wait_for_workstreams for the ones still running, or merge the results and finish.`
  }
}

/** `parent`: a child's coordinator (cycle 83 — the child's rules name it). */
export function promptInfo(ws: WorkstreamRow, final?: string | null, parent?: WorkstreamRow | null): WorkstreamPromptInfo {
  const u = usedOf(ws)
  const role: WorkstreamPromptInfo['role'] = ws.isChild
    ? { kind: 'child', coordinatorGoal: parent?.goal ?? 'its coordinator', workspace: ws.workspaceMode }
    : ws.treeBudget || ws.toolsets.includes('coordinator') ? { kind: 'coordinator' } : undefined
  return {
    goal: ws.goal,
    used: { steps: u.steps, wallMs: u.wallMs },
    budget: budgetOf(ws),
    ...(final ? { final: { reason: final } } : {}),
    ...(role ? { role } : {})
  }
}
