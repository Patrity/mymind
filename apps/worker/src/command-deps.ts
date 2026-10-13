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
  const { readWorkspaceText } = await import('@mymind/core/lib/sandbox/runtime')
  const view = await import('@mymind/core/lib/sandbox/view')
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
    // Task 2: export_to_document replayed in the web reads its file here, where the workspace is.
    workspaceReadText: p => readWorkspaceText(p.workspaceId, p.path, { tainted: p.tainted === true, offline: p.offline === true }),
    // Task 3: the Files / Shells UI (lib/sandbox/view.ts) — every read runs here, in the workspace.
    workspaceView: async (p) => {
      const o = { noStart: p.noStart === true }
      if (p.op === 'tree') return view.viewTree(p.workspaceId, o)
      if (p.op === 'file') return view.viewFile(p.workspaceId, p.path, o)
      if (p.op === 'chunk') return view.readChunk(p.workspaceId, p.path, p.offset, p.length, o)
      return view.shellTail(p.workspaceId, p.shellId, o)
    },
    workspaceKillShell: p => view.killShellFromUi(p.workspaceId, p.shellId),
    // Cycle 85: the eval job — claims the queued run and runs it in the background.
    evalRun: async p => (await import('@mymind/core/lib/eval/runs')).startEvalRun(p.runId),
    // Final fix wave (M1): the deploy's pre-migration cancel — stop those runs now, not at a heartbeat.
    evalCancel: async p => ({ stopped: (await import('@mymind/core/lib/eval/runner')).stopEvalRunsNow(p.runIds) })
  }
}
