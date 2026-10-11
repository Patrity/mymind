// Cycle 82 Task 3: shared by the /api/workspaces routes (Files / Shells UI).
//
// The web NEVER touches Docker or the workspace dirs: every read of a workspace's files or a shell's
// output is a `workspace-view` command the agent worker runs inside the sandbox (lib/sandbox/view.ts).
// Reads take a session or an API token (the auth middleware) — but an API-token read never STARTS a
// stopped sandbox (final review M5: 409 "sandbox stopped — open it in the app"), and the raw
// download is session-only. Writes (kill, re-enable, the secret toggle) are session-only
// (requireSession). None of this is on /api/mcp.
import { z } from 'zod'
import type { H3Event } from 'h3'
import { and, eq, isNull } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { workspaces, type WorkspaceRow } from '@mymind/core/db/schema'
import { sendCommand, workerStatus, CommandFailedError, CommandTimeoutError, type CommandPayloads, type CommandResults, type CommandType } from '@mymind/core/lib/bus/commands'
import { isSessionClient, type ClientContext } from './auth-guard'
import { ensureHomeWorkspace } from '@mymind/core/lib/sandbox/store'
import { workspacePathProblem } from '@mymind/core/lib/sandbox/paths'
import type { WorkspaceDTO } from '@mymind/core/shared/types/workspaces'

/** Fix round 1 (M5): a COLD read can need the preflight, `docker create` (≤ 60s), `docker start`
 *  (≤ 60s) and then the script (≤ 60s) — the budget covers that. A dead worker never waits for it:
 *  the heartbeat is checked first (fail fast). */
export const VIEW_TIMEOUT_MS = 200_000

function fail(statusCode: number, message: string): Error {
  // h3 strips non-ASCII from statusMessage — the readable text rides in data.message.
  return createError({ statusCode, statusMessage: statusCode === 404 ? 'Not found' : statusCode === 400 ? 'Bad request' : 'Workspace error', data: { message } })
}

/** The :id param: a workspace uuid, or `home` (the chat's workspace, created on first use). */
export async function requireWorkspace(event: H3Event): Promise<WorkspaceRow> {
  const id = getRouterParam(event, 'id')
  if (id === 'home') {
    // Fix round 1 (M10): only a web session may CREATE the home workspace (a GET by an API token
    // reads it if it exists, and is a 404 otherwise — never a write behind a read).
    if (isSessionClient(event.context.client as ClientContext | undefined)) return ensureHomeWorkspace()
    const [home] = await useDb().select().from(workspaces).where(and(eq(workspaces.kind, 'home'), isNull(workspaces.deletedAt))).limit(1)
    if (!home) throw fail(404, 'There is no home workspace yet (it is created when Bridget or the web app first uses it).')
    return home
  }
  if (!id || !z.uuid().safeParse(id).success) throw fail(404, 'No such workspace.')
  const [row] = await useDb().select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!row) throw fail(404, 'No such workspace.')
  return row
}

/** An API-token read must not start the sandbox (final review M5); a web session may. */
export function readScope(event: H3Event): { noStart?: true } {
  return isSessionClient(event.context.client as ClientContext | undefined) ? {} : { noStart: true }
}

/** Only a uuid (writes never create the home workspace). */
export function requireWorkspaceUuid(event: H3Event): string {
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) throw fail(404, 'No such workspace.')
  return id
}

export function requireShellId(event: H3Event): string {
  const id = getRouterParam(event, 'shellId')
  if (!id || !z.uuid().safeParse(id).success) throw fail(404, 'No such shell.')
  return id
}

/** ?path= — relative, no `..`, no NUL (checked again in the worker and inside the container). */
export function requirePath(event: H3Event): string {
  const p = getQuery(event).path
  const why = workspacePathProblem(p)
  if (why) throw fail(400, why)
  return p as string
}

export function toWorkspaceDTO(r: WorkspaceRow): WorkspaceDTO {
  return {
    id: r.id, kind: r.kind, workstreamId: r.workstreamId, state: r.state, tainted: r.tainted,
    taintedAt: r.taintedAt?.toISOString() ?? null, bytesUsed: r.bytesUsed, inodesUsed: r.inodesUsed,
    lastUsedAt: r.lastUsedAt.toISOString(), deletedAt: r.deletedAt?.toISOString() ?? null
  }
}

/** Ask the worker; its refusals become UI errors (404 / 400 / 409, a dead worker 504). */
export async function askWorker<K extends CommandType>(type: K, payload: CommandPayloads[K], opts: { discardResult?: boolean } = {}): Promise<CommandResults[K]> {
  // Fail fast (M5): with no fresh heartbeat nothing will answer — don't hold the request open.
  if (!(await workerStatus()).online) throw fail(503, 'The agent worker is offline (the workspace lives there) — start it and try again.')
  try {
    const r = await sendCommand(type, payload, { awaitResult: true, timeoutMs: VIEW_TIMEOUT_MS, ...opts })
    if (r === undefined) throw new Error('the agent worker returned nothing')
    return r as CommandResults[K]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof CommandTimeoutError) {
      throw fail(504, err.claimed
        ? 'The workspace sandbox is still starting (or the read is slow) — try again in a moment.'
        : 'The agent worker did not pick this up (the workspace lives there). Is it running?')
    }
    if (err instanceof CommandFailedError) {
      if (/not found|has been deleted|no such file|no background shell/i.test(message)) throw fail(404, message)
      if (/sandbox stopped — open it in the app/.test(message)) throw fail(409, 'sandbox stopped — open it in the app')
      if (/bad payload|must be relative|must not contain|NUL byte|leads outside|bad chunk/i.test(message)) throw fail(400, message)
      throw fail(409, message)
    }
    throw err
  }
}
