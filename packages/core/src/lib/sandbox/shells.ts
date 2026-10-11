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
import { workspaceShells, workspaces, type WorkspaceShellRow } from '../../db/schema'
import { busNs } from '../bus/ns'
import { publishChange } from '../../utils/live-bus'
import { parseShellStatus, shellKillCommand, shellOutputCommand, shellStartCommand, shellStatusCommand, shellTailCommand, type ShellStatus } from './fs-ops'
import type { ExecOptions, SandboxExecResult } from './manager'
import type { WorkspaceRow } from './store'
import { maskCut, maskText, secretValues } from './secrets'

export type { WorkspaceShellRow }

export interface ShellStore {
  /** Insert a running shell unless `cap` are already running there — count + insert under one
   *  per-workspace lock (fix round 1, M5: parallel calls in one step can't overshoot). null = capped. */
  create(workspaceId: string, command: string, cap: number): Promise<WorkspaceShellRow | null>
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
  async create(workspaceId, command, cap) {
    const r = await useDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mymind:ws-shells:${workspaceId}`}))`)
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workspaceShells)
        .where(and(eq(workspaceShells.workspaceId, workspaceId), eq(workspaceShells.state, 'running'))) as [{ n: number }]
      if (n >= cap) return null
      const [row] = await tx.insert(workspaceShells).values({ workspaceId, command }).returning()
      return row!
    })
    if (r) publish(workspaceId)
    return r
  },
  async get(id) {
    const [r] = await useDb().select().from(workspaceShells).where(eq(workspaceShells.id, id)).limit(1)
    return r ?? null
  },
  async listRunning(workspaceId) {
    // Without a workspace (the boot re-attach): only this bus namespace's workspaces.
    return useDb().select().from(workspaceShells).where(and(eq(workspaceShells.state, 'running'), workspaceId
      ? eq(workspaceShells.workspaceId, workspaceId)
      : sql`${workspaceShells.workspaceId} in (select ${workspaces.id} from ${workspaces} where ${workspaces.ns} = ${busNs()})`))
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
  /** The secret values to mask, longest first (sandbox/secrets.ts; tests inject). */
  secretValues?: () => Promise<string[]>
  /** A housekeeping command in the RUNNING networked container — null when it isn't running. Never
   *  starts a container and never counts as use (final review I2: the liveness refresh). */
  peek?(workspaceId: string, command: string): Promise<SandboxExecResult | null>
}

/** Where an incomplete UTF-8 sequence starts at the end of `raw` (raw.length when it ends cleanly). */
function incompleteUtf8Tail(raw: Buffer): number {
  for (let k = 1; k <= Math.min(3, raw.length); k++) {
    const c = raw[raw.length - k]!
    if ((c & 0xc0) === 0x80) continue // a continuation byte: keep looking for its lead
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
    return need > k ? raw.length - k : raw.length
  }
  return raw.length
}

/**
 * Fix round 1 (M1) + fix round 2: where a bash_output window may END, in BYTES of the raw output
 * (read `overlap` bytes past the chunk, so a value starting before the chunk edge is wholly in it):
 *   - never inside a UTF-8 code point (the edge backs off over continuation bytes, ≤ 3);
 *   - never inside a secret value (the edge moves back to the value's start);
 *   - at the end of what a still-running shell has written so far, a trailing piece that could be
 *     the start of a value — or an incomplete code point — is held back for the next call.
 * The offset then advances by exactly the bytes returned, so reads are contiguous.
 */
export function safeWindowEnd(raw: Buffer, chunkBytes: number, values: string[], atWrittenEnd: boolean): number {
  let end = Math.min(raw.length, chunkBytes)
  if (end < raw.length) for (let k = 0; k < 3 && end > 0 && (raw[end]! & 0xc0) === 0x80; k++) end--
  for (const v of values) {
    const vb = Buffer.from(v)
    let i = raw.indexOf(vb)
    while (i !== -1 && i < end) {
      if (i + vb.length > end) { end = i; break }
      i = raw.indexOf(vb, i + 1)
    }
  }
  if (atWrittenEnd && end === raw.length) {
    let hold = incompleteUtf8Tail(raw)
    for (const v of values) {
      const vb = Buffer.from(v)
      for (let n = Math.min(vb.length - 1, raw.length); n > 0; n--) {
        if (raw.subarray(raw.length - n).equals(vb.subarray(0, n))) { hold = Math.min(hold, raw.length - n); break }
      }
    }
    end = hold
  }
  return end
}

/** bash_output returns at most this much new output per call. */
export const SHELL_OUTPUT_CHUNK = 32 * 1024
/** The Shells UI shows at most this much of a shell's output (its tail). */
export const SHELL_TAIL_BYTES = 16 * 1024
/** Running background shells per workspace. */
export const MAX_RUNNING_SHELLS = 8

export class ShellError extends Error { override name = 'ShellError' }

const TAINT_LOST = "it was stopped when this workspace's network was turned off (the workspace handled mail/calendar content)"


export function createShellRegistry(deps: ShellDeps) {
  const store = deps.store ?? dbShellStore
  const log = deps.log ?? console
  const maskValues = deps.secretValues ?? secretValues

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
    const row = await store.create(workspaceId, command, MAX_RUNNING_SHELLS)
    if (!row) throw new ShellError(`${MAX_RUNNING_SHELLS} background shells are already running in this workspace (the limit) — stop one with kill_shell first`)
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

  /** New output since the last call (≤ SHELL_OUTPUT_CHUNK) + the shell's state. Secret values are
   *  masked here, on a window read past the chunk edge (fix round 1, M1: a value straddling the edge
   *  is either returned whole — masked — or left for the next call; never split in two halves). */
  async function output(workspaceId: string, shellId: string, o: Pick<ExecOptions, 'tainted' | 'signal'> = {}) {
    let row = await own(workspaceId, shellId)
    const values = await maskValues()
    // ≥ 4: a code point straddling the chunk edge is always wholly in the window too (fix round 2).
    const overlap = values.reduce((m, v) => Math.max(m, Buffer.byteLength(v)), 4)
    const r = await deps.exec(workspaceId, shellOutputCommand(row.id, row.readOffset, SHELL_OUTPUT_CHUNK + overlap), { timeoutSec: 30, capBytes: (SHELL_OUTPUT_CHUNK + overlap) * 2, ...o })
    const st = parseShellStatus(r.stdout)
    if (!st) throw new ShellError(`could not read the shell's output: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`)
    const start = row.readOffset
    const raw = Buffer.from(st.output.trim(), 'base64')
    if (raw.length !== st.n) throw new ShellError(`could not read the shell's output (got ${raw.length} of ${st.n} bytes)`)
    // A half-written value / code point held back at the end is not "more": nothing new to read yet.
    const atWrittenEnd = st.status.state === 'running' && start + st.n >= st.size
    const advance = safeWindowEnd(raw, SHELL_OUTPUT_CHUNK, values, atWrittenEnd)
    const heldBack = atWrittenEnd && st.n <= SHELL_OUTPUT_CHUNK
    const text = raw.subarray(0, advance).toString('utf8')
    if (advance > 0) await store.setOffset(row.id, start + advance)
    row = await settle(row, st.status)
    return {
      shellId: row.id,
      state: row.state,
      ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      output: maskText(text, values),
      /** More output is waiting beyond this chunk — call bash_output again. */
      more: start + advance < st.size && !heldBack,
      outputBytes: st.size,
      tainted: r.tainted
    }
  }

  async function kill(workspaceId: string, shellId: string, o: Pick<ExecOptions, 'tainted' | 'signal'> & { reason?: string } = {}) {
    const { reason = 'stopped with kill_shell', ...eo } = o
    const row = await own(workspaceId, shellId)
    if (row.state !== 'running') return { shellId, state: row.state, alreadyEnded: true, tainted: false }
    const r = await deps.exec(workspaceId, shellKillCommand(row.id), { timeoutSec: 30, ...eo })
    const st = parseShellStatus(r.stdout)
    if (st?.status.state === 'exited') await store.end(row.id, { state: 'exited', exitCode: st.status.exitCode })
    else await store.end(row.id, { state: 'killed', reason })
    const after = await store.get(row.id)
    return { shellId, state: after?.state ?? 'killed', alreadyEnded: false, tainted: r.tainted }
  }

  /** The last `max` bytes of a shell's output + its state, for the Shells UI. Read-only: it never
   *  moves bash_output's offset; a status it finds (exited/lost) is recorded like any other read. */
  async function tail(workspaceId: string, shellId: string, max = SHELL_TAIL_BYTES, o: Pick<ExecOptions, 'noStart'> = {}) {
    let row = await own(workspaceId, shellId)
    const values = await maskValues()
    const r = await deps.exec(workspaceId, shellTailCommand(row.id, max), { timeoutSec: 30, capBytes: max * 2, ...(o.noStart ? { noStart: true } : {}) })
    const st = parseShellStatus(r.stdout)
    if (!st) throw new ShellError(`could not read the shell's output: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`)
    row = await settle(row, st.status)
    // M1: masked whole before any cut edge is trimmed — the start when older output was dropped, the
    // end while the shell still writes (a value may be half-written).
    const output = maskCut(st.output, values, { start: st.n < st.size, end: st.status.state === 'running' })
    return { shellId: row.id, state: row.state, exitCode: row.exitCode, reason: row.reason, output, outputBytes: st.size, truncated: st.n < st.size }
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

  /**
   * Final review I2 (every quota tick): re-check the running rows of a workspace whose container is
   * up — a shell that exited (or vanished) while nobody read its output is recorded, so a dead row
   * never looks like a live job. Read-only on the sandbox (status only, no offset moved).
   */
  async function refresh(workspaceId: string): Promise<number> {
    if (!deps.peek) return 0
    let ended = 0
    for (const row of await store.listRunning(workspaceId)) {
      const r = await deps.peek(workspaceId, shellStatusCommand(row.id))
      if (!r) break // the container is not running: its rows are settled by whatever stopped it
      const st = parseShellStatus(r.stdout)
      if (!st) continue
      if ((await settle(row, st.status)).state !== 'running') ended++
    }
    return ended
  }

  return { start, output, tail, kill, killAll, reconcile, hasRunning, refresh, list: (workspaceId: string, limit?: number) => store.list(workspaceId, limit) }
}

export type ShellRegistry = ReturnType<typeof createShellRegistry>
