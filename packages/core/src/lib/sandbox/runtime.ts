// Cycle 82 Task 2: the workspace runtime in the WORKER — which workspace a run works in, the
// background-shell registry and the watch runtime bound to the shared sandbox manager, and their
// boot/stop (main.ts startSandbox).
//
//   Workspace selection: a run in a workstream's thread works in that workstream's workspace; every
//   other run (chat, jobs, wakes, replayed proposals) works in the single `home` workspace. Both are
//   created on first use.
//   Boot: after the container reconcile, running background shells are re-attached (or marked
//   lost/exited) and armed watches re-armed. The manager's isBusy (no idle stop while a shell runs
//   or a watch is armed) and onOverQuota (kill shells, cancel watches) hooks are installed here.
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentRuns } from '../../db/schema'
import { sandboxManager, setSandboxRuntimeHooks, type SandboxManager } from './manager'
import { dbWorkspaceStore, ensureHomeWorkspace, ensureWorkstreamWorkspace } from './store'
import { createShellRegistry, type ShellRegistry } from './shells'
import { createWatchRuntime, type WatchRuntime, type WorkspaceWatchRow } from './watches'
import { READ_TEXT_CAP_BYTES, READ_TEXT_SCRIPT } from './fs-ops'
import { executionMode } from '../agent/runtime/execution-mode'
import type { ExecOptions } from './manager'

export interface WorkspaceRef {
  workspaceId: string
  kind: 'home' | 'workstream'
  workstreamId: string | null
  /** The conversation the calling run belongs to (where a chat watch posts its note). */
  conversationId: string | null
}

/** Which workspace a tool call works in (see the header). */
export async function resolveWorkspace(runId: string | undefined): Promise<WorkspaceRef> {
  let conversationId: string | null = null
  if (runId) {
    const [r] = await useDb().select({ conversationId: agentRuns.conversationId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    conversationId = r?.conversationId ?? null
  }
  if (conversationId) {
    const { workstreamForConversation } = await import('../agent/workstreams/store')
    const ws = await workstreamForConversation(conversationId)
    if (ws) {
      const row = await ensureWorkstreamWorkspace(ws.id)
      return { workspaceId: row.id, kind: 'workstream', workstreamId: ws.id, conversationId }
    }
  }
  const home = await ensureHomeWorkspace()
  return { workspaceId: home.id, kind: 'home', workstreamId: null, conversationId }
}

/**
 * A watch ended: wake its workstream (a new segment when none is live — otherwise its next segment
 * boundary takes the result), or note into the chat it was set from once no turn is running there
 * (an event row appended mid-turn would hang off a branch the turn then leaves behind).
 */
async function deliverWatch(row: WorkspaceWatchRow): Promise<'delivered' | 'pending'> {
  if (row.workstreamId) {
    const { wakeWorkstreamForWatch } = await import('../agent/workstreams/loop')
    return (await wakeWorkstreamForWatch(row.workstreamId)) === 'pending' ? 'pending' : 'delivered'
  }
  if (!row.conversationId) return 'delivered'
  const [busy] = await useDb().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.conversationId, row.conversationId), inArray(agentRuns.status, ['queued', 'running']))).limit(1)
  if (busy) return 'pending'
  const { appendEvent } = await import('../../services/conversations')
  await appendEvent(row.conversationId, row.resultText ?? `The watch \`${row.command}\` ended (${row.state}).`, `workspace:watch:${row.state}`)
  return 'delivered'
}

async function watchOwnerGone(row: WorkspaceWatchRow): Promise<boolean> {
  if (!row.workstreamId) return false
  const { getWorkstream } = await import('../agent/workstreams/store')
  const { TERMINAL_WORKSTREAM_STATES } = await import('../../shared/types/workstreams')
  const ws = await getWorkstream(row.workstreamId)
  return !ws || TERMINAL_WORKSTREAM_STATES.includes(ws.state)
}

export interface WorkspaceRuntime {
  manager: SandboxManager
  shells: ShellRegistry
  watches: WatchRuntime
  /** Which workspace a run works in (resolveWorkspace; tests pin one). */
  resolve: (runId: string | undefined) => Promise<WorkspaceRef>
}

let shared: WorkspaceRuntime | null = null

/** The worker's workspace runtime (lazily bound to the shared manager). */
export function workspaceRuntime(): WorkspaceRuntime {
  return shared ??= createWorkspaceRuntime(sandboxManager())
}

/** Test seam: swap the runtime (unit tests use fakes). */
export function setWorkspaceRuntime(rt: WorkspaceRuntime | null): void { shared = rt }

export const OVER_QUOTA_REASON = 'the workspace went over its disk quota (or the server ran low on disk)'

/** Build a runtime around a given manager (tests: a labelled manager on a temp dir). */
export function createWorkspaceRuntime(manager: SandboxManager, o: { resolve?: WorkspaceRuntime['resolve']; deliver?: Parameters<typeof createWatchRuntime>[0]['deliver'] } = {}): WorkspaceRuntime {
  const deps = { exec: manager.exec, workspace: (id: string) => dbWorkspaceStore.get(id) }
  return {
    manager,
    shells: createShellRegistry(deps),
    watches: createWatchRuntime({ ...deps, deliver: o.deliver ?? deliverWatch, ownerGone: watchOwnerGone }),
    resolve: o.resolve ?? resolveWorkspace
  }
}

/** isBusy / onOverQuota for the manager (exported for tests). onOverQuota is idempotent: it only
 *  touches running shells / armed watches, so the 5s low-disk repeats find nothing to do. */
export function runtimeHooks(rt: Pick<WorkspaceRuntime, 'shells' | 'watches'>) {
  return {
    isBusy: async (id: string) => (await rt.shells.hasRunning(id)) || (await rt.watches.hasArmed(id)),
    onOverQuota: async (id: string) => {
      await rt.shells.killAll(id, `killed: ${OVER_QUOTA_REASON}`)
      await rt.watches.cancelFor(id, OVER_QUOTA_REASON)
    }
  }
}

/**
 * Worker start: install the manager hooks now; once the container reconcile has run (housekeeping's
 * first tick calls `afterReconcile`), re-attach shells and re-arm watches. Returns stop().
 */
export function startWorkspaceRuntime(log: Pick<Console, 'info' | 'warn' | 'error'> = console): { afterReconcile: () => Promise<void>; stop: () => void } {
  const rt = workspaceRuntime()
  setSandboxRuntimeHooks(runtimeHooks(rt))
  let stopped = false
  return {
    afterReconcile: async () => {
      if (stopped) return
      try {
        const s = await rt.shells.reconcile()
        if (s.reattached || s.ended) log.info(`[sandbox] background shells: ${s.reattached} re-attached, ${s.ended} ended while the worker was down`)
      } catch (err) { log.error('[sandbox] shell reconcile failed:', err) }
      if (stopped) return
      try {
        const n = await rt.watches.start()
        if (n) log.info(`[sandbox] re-armed ${n} watch(es)`)
      } catch (err) { log.error('[sandbox] re-arming watches failed:', err) }
    },
    stop: () => { stopped = true; rt.watches.stop() }
  }
}

export class WorkspaceFileError extends Error { override name = 'WorkspaceFileError' }

/**
 * A whole UTF-8 text file of a workspace (≤ EXPORT_MAX_BYTES), read INSIDE its sandbox. In the web
 * process (an approved export_to_document proposal is replayed there) the worker does the read —
 * the sandbox is the worker's.
 */
export async function readWorkspaceText(workspaceId: string, path: string, o: Pick<ExecOptions, 'tainted' | 'signal'> = {}): Promise<{ content: string; bytes: number; path: string; tainted: boolean }> {
  if (executionMode() === 'remote') {
    const { sendCommand } = await import('../bus/commands')
    const r = await sendCommand('workspace-read-text', { workspaceId, path }, { awaitResult: true, timeoutMs: 60_000 })
    if (!r) throw new WorkspaceFileError('the agent worker returned nothing')
    return r
  }
  const r = await workspaceRuntime().manager.exec(workspaceId, READ_TEXT_SCRIPT, { input: JSON.stringify({ path }), capBytes: READ_TEXT_CAP_BYTES, timeoutSec: 60, ...o })
  let j: { content?: string; bytes?: number; path?: string; error?: string; message?: string } | null = null
  try { j = r.exitCode === 0 ? JSON.parse(r.stdout) : null } catch { j = null }
  if (!j) throw new WorkspaceFileError(r.truncated ? 'the file is too large to export' : `could not read ${path}: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`)
  if (j.error) throw new WorkspaceFileError(`${path}: ${j.message ?? j.error.replace(/_/g, ' ')}`)
  return { content: j.content ?? '', bytes: j.bytes ?? 0, path: j.path ?? path, tainted: r.tainted }
}
