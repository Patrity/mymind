// Cycle 82 Task 3: shared by the /api/workspaces routes (Files / Shells UI).
//
// The web NEVER touches Docker or the workspace dirs: every read of a workspace's files or a shell's
// output is a `workspace-view` command the agent worker runs inside the sandbox (lib/sandbox/view.ts).
// Reads take a session or an API token (the auth middleware); writes (kill, re-enable, the secret
// toggle) are session-only (requireSession). None of this is on /api/mcp.
import { z } from 'zod'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { workspaces, type WorkspaceRow } from '@mymind/core/db/schema'
import { sendCommand, CommandFailedError, CommandTimeoutError, type CommandPayloads, type CommandResults, type CommandType } from '@mymind/core/lib/bus/commands'
import { ensureHomeWorkspace } from '@mymind/core/lib/sandbox/store'
import { workspacePathProblem } from '@mymind/core/lib/sandbox/paths'
import type { WorkspaceDTO } from '@mymind/core/shared/types/workspaces'

export const VIEW_TIMEOUT_MS = 75_000

function fail(statusCode: number, message: string): Error {
  // h3 strips non-ASCII from statusMessage — the readable text rides in data.message.
  return createError({ statusCode, statusMessage: statusCode === 404 ? 'Not found' : statusCode === 400 ? 'Bad request' : 'Workspace error', data: { message } })
}

/** The :id param: a workspace uuid, or `home` (the chat's workspace, created on first use). */
export async function requireWorkspace(event: H3Event): Promise<WorkspaceRow> {
  const id = getRouterParam(event, 'id')
  if (id === 'home') return ensureHomeWorkspace()
  if (!id || !z.uuid().safeParse(id).success) throw fail(404, 'No such workspace.')
  const [row] = await useDb().select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!row) throw fail(404, 'No such workspace.')
  return row
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
  try {
    const r = await sendCommand(type, payload, { awaitResult: true, timeoutMs: VIEW_TIMEOUT_MS, ...opts })
    if (r === undefined) throw new Error('the agent worker returned nothing')
    return r as CommandResults[K]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof CommandTimeoutError) throw fail(504, 'The agent worker did not answer (the workspace lives there). Is it running?')
    if (err instanceof CommandFailedError) {
      if (/not found|has been deleted|no such file|no background shell/i.test(message)) throw fail(404, message)
      if (/bad payload|must be relative|must not contain|NUL byte|leads outside|bad chunk/i.test(message)) throw fail(400, message)
      throw fail(409, message)
    }
    throw err
  }
}
