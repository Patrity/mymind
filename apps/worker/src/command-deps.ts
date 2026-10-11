// The real implementations behind the worker's command handlers that act on core state (cycle 81
// Task 4). Shared by main.ts and the DB tests' worker child (test/fixtures/worker-commands), so the
// child exercises exactly what the worker runs. Must be called after initCore (core touches the DB).
import type { CommandDeps } from './worker'

export async function coreCommandDeps(): Promise<Omit<CommandDeps, 'kick'>> {
  const [queue, inbound, busApprovals, undo, presence, invalidate, workstreams] = await Promise.all([
    import('@mymind/core/lib/agent/runtime/queue'),
    import('@mymind/core/lib/channels/inbound'),
    import('@mymind/core/lib/agent/runtime/bus-approvals'),
    import('@mymind/core/lib/agent/undo'),
    import('@mymind/core/lib/channels/presence'),
    import('@mymind/core/lib/bus/invalidate'),
    import('@mymind/core/lib/agent/workstreams/loop')
  ])
  const { sandboxManager } = await import('@mymind/core/lib/sandbox/manager')
  const { readWorkspaceText } = await import('@mymind/core/lib/sandbox/runtime')
  return {
    // Stop / barge-in / `/clear` (spec §3.5): the answer is honest — `/clear` writes its epoch only
    // on settled:true.
    abort: p => queue.abortForCommand(p),
    imessageHealth: async (action) => {
      if (action === 'reset') inbound.resetHealth()
      else await inbound.catchUpTick({ force: true })
      return inbound.lastHealth()
    },
    approvalDecision: p => busApprovals.decideBusApproval(p),
    undo: token => undo.runUndo(token),
    presence: at => presence.markActive(at),
    invalidate: cache => invalidate.invalidateLocalCache(cache),
    // Cancel / resume / steer (spec §3.2, §5.5): acts on this process's segments + the DB, then kicks.
    workstreamControl: p => workstreams.controlWorkstream(p),
    // Cycle 82: the sandbox lives here — kill the workspace's tainted runs, then clear the taint.
    workspaceReenableNetwork: async (p) => {
      const row = await sandboxManager().reenableNetwork(p.workspaceId)
      return { id: row.id, tainted: row.tainted }
    },
    // Task 2: export_to_document replayed in the web reads its file here, in the sandbox.
    workspaceReadText: p => readWorkspaceText(p.workspaceId, p.path, { tainted: p.tainted === true })
  }
}
