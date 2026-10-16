// server/lib/agent/runtime/gate.ts
// What a background run may do on its own. Interactive Bridget runs edits immediately behind
// undo because Tony is watching; with nobody watching, anything that edits or destroys existing
// data becomes a /review proposal instead (deny → propose → continue). Classification is
// EXPLICIT: a new tool that is neither read, a known append, nor a known mutation throws here,
// so it cannot silently default into running unattended.
import { useDb } from '../../../db'
import { reviewQueue } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import type { AgentTool } from '../types'

export type HeadlessClass = 'run' | 'propose' | 'exclude'
export interface AgentActionProposal { runId: string; conversationId: string; tool: string; args: Record<string, unknown> }
export type ProposeFn = (p: AgentActionProposal) => Promise<string>

export const APPEND_TOOLS: ReadonlySet<string> = new Set([
  'save_memory', 'create_task', 'create_project', 'quick_capture', 'generate_image', 'save_document',
  // jobs (cycle 74, Task 8, spec D2): Bridget may edit her own jobs freely, including in
  // background runs — job management is her own upkeep, not a change to Tony's data.
  'create_job', 'edit_job', 'run_job', 'schedule_wake',
  // send_message (cycle 75, Task 10): Tony-only, rate-limited, never rethrows — an outbound
  // note to Tony, not a change to his data, so it runs headless like the other append tools.
  'send_message',
  // gmail_draft (cycle 79): creates an unsent draft (undo deletes it) — nothing leaves the
  // mailbox, so it runs headless; sending is gmail_send, which is dangerous and excluded.
  'gmail_draft',
  // workstreams (cycle 81, spec §5.3): finish_workstream and ask_tony only report to Tony from inside
  // a workstream.
  'finish_workstream', 'ask_tony',
  // workspace (cycle 82, spec §4): everything happens inside Bridget's own sandbox — none of it
  // touches Tony's data (no approvals; network governed by taint, not by the gate).
  'write_file', 'edit_file', 'bash', 'kill_shell', 'watch', 'import_document', 'delete_files',
  // coordinator (cycle 83, spec §4: headless "run"): they act only on the workstream's OWN children
  // (budget-bounded, from inside a workstream — never a chat/job run), and export_to_coordinator only
  // copies between its own sandboxes.
  // artifacts (cycle 87): a private page is Bridget's own output (undoable); a PUBLIC html/files one is proposed via
  // proposeWhen (a public workspace_path one is refused — R10). Both are `outbound` (R9): tainted → auto-denied.
  'publish_artifact', 'edit_artifact',
  'spawn_workstreams', 'steer_workstream', 'answer_child', 'cancel_workstreams', 'export_to_coordinator'
])
export const PROPOSE_TOOLS: ReadonlySet<string> = new Set(['edit_document', 'edit_section', 'update_document', 'move_document', 'sync_document', 'edit_image', 'create_skill', 'edit_skill',
  // gmail_modify (cycle 79): archives/relabels existing mail — Tony approves it in a headless run
  'gmail_modify',
  // calendar_write_event (cycle 79): edits/deletes Tony's own events (no guests, nobody notified)
  // — in a headless run Tony approves it as a proposal
  'calendar_write_event',
  // start_workstream (cycle 81, review I2 ruling): a background run must not spawn hours of new
  // unattended work on its own — Tony approves it as a proposal (replay starts it).
  'start_workstream',
  // answer_workstream (fix round 2, I-new-1): a background run must not feed a workstream text of
  // its own choosing — proposed, replayed on approval
  'answer_workstream',
  // export_to_document (cycle 82, spec §4): writes workspace content into Tony's corpus (it may
  // replace an existing document) — proposed headless, replayed on approval
  'export_to_document'])

// Tools that run headless DESPITE being `destructive`-kind — checked BEFORE the destructive rule
// below, so they never fall into 'propose'. Currently just delete_job: spec D2 says job
// deletion is free even in a background run, same reasoning as the APPEND_TOOLS jobs entries
// above (Bridget's own upkeep, not a change to Tony's data) — it's `destructive`-kind only
// because it removes a row, not because it needs a human in the loop: the delete records a
// final revision and restoreJob brings the job back under its original id (final review I2).
export const FREE_TOOLS: ReadonlySet<string> = new Set(['delete_job'])

export function classifyForHeadless(t: AgentTool): HeadlessClass {
  if (t.dangerous) return 'exclude'
  if (t.kind === 'read') return 'run'
  if (APPEND_TOOLS.has(t.name)) return 'run'
  if (FREE_TOOLS.has(t.name)) return 'run'
  if (t.kind === 'destructive' || PROPOSE_TOOLS.has(t.name)) return 'propose'
  throw new Error(`unclassified tool for headless runs: ${t.name} (kind ${t.kind}) — add it to APPEND_TOOLS or PROPOSE_TOOLS`)
}

export async function proposeAction(p: AgentActionProposal): Promise<string> {
  const [row] = await useDb().insert(reviewQueue).values({
    targetKind: 'agent_run', targetId: p.runId, kind: 'agent-action',
    proposed: { tool: p.tool, args: p.args, conversationId: p.conversationId }
  }).returning({ id: reviewQueue.id })
  publishChange({ resource: 'review', action: 'created', id: row!.id })
  return row!.id
}

export function headlessTools(registry: AgentTool[], run: { id: string; conversationId: string }, propose: ProposeFn = proposeAction): AgentTool[] {
  const proposeCall = async (t: AgentTool, given: Record<string, unknown>, ctx?: Parameters<AgentTool['handler']>[1]) => {
    const args = t.proposalArgs && ctx ? await t.proposalArgs(given, ctx) : given
    const reviewId = await propose({ runId: run.id, conversationId: run.conversationId, tool: t.name, args })
    return {
      result: { proposed: true, reviewId, note: "Queued for Tony's approval in /review." },
      summary: `proposed ${t.name} for approval`
    }
  }
  const out: AgentTool[] = []
  for (const t of registry) {
    const c = classifyForHeadless(t)
    if (c === 'exclude') continue
    if (c === 'run') {
      // 79b (d): a `run` tool may still need Tony for SOME calls (gmail_draft replacing an
      // existing draft). Those calls take the propose path; every other call runs as before.
      // Replay (runtime/replay.ts) resolves the ORIGINAL registry tool, so an approved proposal
      // executes the real handler.
      const when = t.proposeWhen
      out.push(when
        ? { ...t, handler: async (args, ctx) => when(args) ? proposeCall(t, args, ctx) : t.handler(args, ctx) }
        : t)
      continue
    }
    out.push({ ...t, dangerous: false, handler: async (args, ctx) => proposeCall(t, args, ctx) })
  }
  return out
}
