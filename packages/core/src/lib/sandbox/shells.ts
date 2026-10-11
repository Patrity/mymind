// Cycle 82 Task 2: background shells — the per-workspace registry behind `bash` with
// run_in_background, `bash_output` and `kill_shell`.
//
// The process lives INSIDE the workspace's sandbox (a `setsid` session leader, fs-ops.ts
// shellStartCommand) and writes `/workspace/.mymind/shells/<id>/{out,pid,exit}`; the DB row is the
// registry (which shells exist, their state, how much output was already returned). A worker restart
// does not stop the sandbox container, so on boot `reconcile` RE-ATTACHES every shell that is still
// running (nothing to do but keep its row) and marks the others `exited` (exit file) or `lost` (the
// sandbox or the process is gone with no exit code — e.g. the container was recreated for a new
// image, stopped by the disk watchdog, or killed when the workspace was tainted).
import { and, eq, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { workspaceShells, type WorkspaceShellRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { parseShellStatus, shellKillCommand, shellOutputCommand, shellStartCommand, shellStatusCommand, type ShellStatus } from './fs-ops'
import type { ExecOptions, SandboxExecResult } from './manager'
import type { WorkspaceRow } from './store'

export type { WorkspaceShellRow }

export interface ShellStore {
  create(workspaceId: string, command: string): Promise<WorkspaceShellRow>
  get(id: string): Promise<WorkspaceShellRow | null>
  listRunning(workspaceId?: string): Promise<WorkspaceShellRow[]>
  list(workspaceId: string, limit?: number): Promise<WorkspaceShellRow[]>
  /** Ends a RUNNING shell (guarded: false when it had already ended). */
  end(id: string, patch: { state: Exclude<WorkspaceShellRow['state'], 'running'>; exitCode?: number | null; reason?: string | null }): Promise<boolean>
  setOffset(id: string, offset: number): Promise<void>
}

function publish(workspaceId: string): void {
  // The Shells tab (Task 3) lives under the workspace resource.
  publishChange({ resource: 'workspace', action: 'updated', id: workspaceId })
}

export const dbShellStore: ShellStore = {
  async create(workspaceId, command) {
    const [r] = await useDb().insert(workspaceShells).values({ workspaceId, command }).returning()
    publish(workspaceId)
    return r!
  },
  async get(id) {
    const [r] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, id)).limit(1)
    return r ?? null
  },
  async listRunning(workspaceId) {
    return useDb().select().from(workspaceShells).where(and(eq(workspaceShells.state, 'running'), workspaceId ? eq(workspaceShells.workspaceId, workspaceId) : undefined))
  },
  async list(workspaceId, limit = 50) {
    return useDb().select().from(workspaceShells).where(eq(workspaceShells.workspaceId, workspaceId)).orderBy(sql`${workspaceShells.startedAt} desc`).limit(limit)
  },
  async end(id, patch) {
    const rows = await useDb().update(workspaceShells).set({ state: patch.state, exitCode: patch.exitCode ?? null, reason: patch.reason ?? null, endedAt: new Date() })
      .where(and(eq(workspaceShells.id, id), eq(workspaceShells.state, 'running'))).returning({ ws: workspaceShells.workspaceId })
    if (rows[0]) publish(rows[0].ws)
    return rows.length > 0
  },
  async setOffset(id, offset) {
    await useDb().update(workspaceShells).set({ readOffset: offset }).where(eq(workspaceShells.id, id))
  }
}

/** What the registry needs from the sandbox manager + the workspaces table. */
export interface ShellDeps {
  exec(workspaceId: string, command: string, o?: ExecOptions): Promise<SandboxExecResult>
  workspace(workspaceId: string): Promise<WorkspaceRow | null>
  store?: ShellStore
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

/** bash_output returns at most this much new output per call. */
export const SHELL_OUTPUT_CHUNK = 32 * 1024
/** Running background shells per workspace. */
export const MAX_RUNNING_SHELLS = 8

export class ShellError extends Error { override name = 'ShellError' }

const TAINT_LOST = "it was stopped when this workspace's network was turned off (the workspace handled mail/calendar content)"

export function createShellRegistry(deps: ShellDeps) {
  const store = deps.store ?? dbShellStore
  const log = deps.log ?? console

  async function lostReason(workspaceId: string, fallback: string): Promise<string> {
    const ws = await deps.workspace(workspaceId)
    return ws?.tainted ? TAINT_LOST : fallback
  }

  /** Persist what a status check found (running rows only — an ended row stays as it ended). */
  async function settle(row: WorkspaceShellRow, st: ShellStatus): Promise<WorkspaceShellRow> {
    if (row.state !== 'running' || st.state === 'running') return row
    if (st.state === 'exited') {
      await store.end(row.id, { state: 'exited', exitCode: st.exitCode })
    } else {
      await store.end(row.id, { state: 'lost', reason: await lostReason(row.workspaceId, 'the sandbox or its process went away without an exit code (worker restart with a new image, idle/disk stop, or a crash)') })
    }
    return (await store.get(row.id)) ?? row
  }

  async function start(workspaceId: string, command: string, o: Pick<ExecOptions, 'secrets'> = {}): Promise<{ shellId: string; pid: number }> {
    const running = await store.listRunning(workspaceId)
    if (running.length >= MAX_RUNNING_SHELLS) throw new ShellError(`${running.length} background shells are already running in this workspace (the limit is ${MAX_RUNNING_SHELLS}) — stop one with kill_shell first`)
    const row = await store.create(workspaceId, command)
    let r: SandboxExecResult
    try {
      r = await deps.exec(workspaceId, shellStartCommand(row.id), { input: command, timeoutSec: 30, ...(o.secrets ? { secrets: o.secrets } : {}) })
    } catch (err) {
      await store.end(row.id, { state: 'lost', reason: `could not start: ${(err as Error).message}` })
      throw err
    }
    const pid = Number(r.stdout.match(/__mm_shell_pid__:(\d+)/)?.[1] ?? NaN)
    if (r.exitCode !== 0 || !Number.isFinite(pid) || r.tainted) {
      // A tainted workspace runs every command in a one-off container that is gone when the launcher
      // returns — a background shell cannot outlive it (the tool refuses before reaching here).
      await store.end(row.id, { state: 'lost', reason: r.tainted ? TAINT_LOST : `could not start (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}` })
      throw new ShellError(r.tainted ? `background shells need the workspace's network, and ${TAINT_LOST}` : `could not start the background shell: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`)
    }
    return { shellId: row.id, pid }
  }

  async function own(workspaceId: string, shellId: string): Promise<WorkspaceShellRow> {
    const row = await store.get(shellId)
    if (!row || row.workspaceId !== workspaceId) throw new ShellError(`no background shell ${shellId} in this workspace`)
    return row
  }

  /** New output since the last call (≤ SHELL_OUTPUT_CHUNK) + the shell's state. */
  async function output(workspaceId: string, shellId: string, o: Pick<ExecOptions, 'tainted' | 'signal'> = {}) {
    let row = await own(workspaceId, shellId)
    const r = await deps.exec(workspaceId, shellOutputCommand(row.id, row.readOffset, SHELL_OUTPUT_CHUNK), { timeoutSec: 30, capBytes: SHELL_OUTPUT_CHUNK * 2, ...o })
    const st = parseShellStatus(r.stdout)
    if (!st) throw new ShellError(`could not read the shell's output: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`)
    if (st.n > 0) await store.setOffset(row.id, row.readOffset + st.n)
    row = await settle(row, st.status)
    return {
      shellId: row.id,
      state: row.state,
      ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      output: st.output,
      /** More output is waiting beyond this chunk — call bash_output again. */
      more: row.readOffset + st.n < st.size,
      outputBytes: st.size,
      tainted: r.tainted
    }
  }

  async function kill(workspaceId: string, shellId: string, o: Pick<ExecOptions, 'tainted' | 'signal'> = {}) {
    const row = await own(workspaceId, shellId)
    if (row.state !== 'running') return { shellId, state: row.state, alreadyEnded: true, tainted: false }
    const r = await deps.exec(workspaceId, shellKillCommand(row.id), { timeoutSec: 30, ...o })
    const st = parseShellStatus(r.stdout)
    if (st?.status.state === 'exited') await store.end(row.id, { state: 'exited', exitCode: st.status.exitCode })
    else await store.end(row.id, { state: 'killed', reason: 'stopped with kill_shell' })
    const after = await store.get(row.id)
    return { shellId, state: after?.state ?? 'killed', alreadyEnded: false, tainted: r.tainted }
  }

  /**
   * Over quota / low disk (the manager's onOverQuota, which fires every 5s per workspace during a
   * low-disk episode — carry-over: idempotent and cheap). Only RUNNING rows are touched, so a
   * second call finds nothing and does one indexed query. The in-sandbox kill runs only when the
   * networked container is up and untainted (a stopped container's processes are already dead,
   * and exec would otherwise START it just to kill nothing).
   */
  async function killAll(workspaceId: string, reason: string): Promise<number> {
    const rows = await store.listRunning(workspaceId)
    if (!rows.length) return 0
    const ws = await deps.workspace(workspaceId)
    let n = 0
    for (const row of rows) {
      if (ws && ws.state === 'running' && !ws.tainted) {
        try { await deps.exec(workspaceId, shellKillCommand(row.id), { timeoutSec: 30 }) } catch (err) {
          log.warn(`[sandbox] killing shell ${row.id} failed (marked killed anyway):`, (err as Error).message)
        }
      }
      if (await store.end(row.id, { state: 'killed', reason })) n++
    }
    return n
  }

  /** Worker boot: re-attach running shells; mark the rest exited / lost. */
  async function reconcile(): Promise<{ reattached: number; ended: number }> {
    let reattached = 0
    let ended = 0
    for (const row of await store.listRunning()) {
      try {
        const ws = await deps.workspace(row.workspaceId)
        if (!ws || ws.deletedAt || ws.tainted || ws.state !== 'running') {
          await store.end(row.id, { state: 'lost', reason: ws?.tainted ? TAINT_LOST : 'the sandbox was stopped while it ran (worker restart, idle/disk stop or image update)' })
          ended++
          continue
        }
        const r = await deps.exec(row.workspaceId, shellStatusCommand(row.id), { timeoutSec: 30 })
        const st = parseShellStatus(r.stdout)
        if (!st) continue // unreadable now — checked again by the next bash_output
        const after = await settle(row, st.status)
        if (after.state === 'running') reattached++
        else ended++
      } catch (err) { log.warn(`[sandbox] reconcile of shell ${row.id} failed:`, (err as Error).message) }
    }
    return { reattached, ended }
  }

  async function hasRunning(workspaceId: string): Promise<boolean> {
    return (await store.listRunning(workspaceId)).length > 0
  }

  return { start, output, kill, killAll, reconcile, hasRunning, list: (workspaceId: string, limit?: number) => store.list(workspaceId, limit) }
}

export type ShellRegistry = ReturnType<typeof createShellRegistry>
