// Cycle 81 Task 6: shared by the /api/workstreams routes — id validation, the control round trip to
// the agent worker, and turning its refusals into errors the UI can show as they are.
import { z } from 'zod'
import type { H3Event } from 'h3'
import { sendCommand, CommandFailedError, CommandTimeoutError } from '@mymind/core/lib/bus/commands'
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'

export function requireWorkstreamId(event: H3Event): string {
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: 'No such workstream', data: { message: 'No such workstream.' } })
  }
  return id
}

/**
 * An error for the UI. h3 strips non-ASCII from `statusMessage`, so the readable text rides in
 * `data.message` (the client reads that first). Cycle 83: the top-level cap (409 `cap`) is gone.
 */
export function workstreamError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof CommandTimeoutError) {
    const text = err.claimed
      ? 'The agent worker took the request but has not finished it after 10s — it may still happen.'
      : 'The agent worker did not answer within 10s, so nothing was done. Is it running?'
    return createError({ statusCode: 504, statusMessage: 'Agent worker did not answer', data: { code: 'timeout', message: text } })
  }
  if (err instanceof CommandFailedError) {
    const notFound = /no such workstream/i.test(message)
    return createError({ statusCode: notFound ? 404 : 409, statusMessage: notFound ? 'No such workstream' : 'Refused', data: { code: notFound ? 'not-found' : 'refused', message } })
  }
  return err instanceof Error ? err : new Error(message)
}

/** Cancel / resume / steer go to the WORKER (it holds the running segment in memory — a cancel
 *  has to reach it), and wait for its answer: a dead worker is a visible 504, never a silent OK. */
export async function sendWorkstreamControl(id: string, action: 'cancel' | 'resume' | 'steer', text?: string): Promise<WorkstreamDTO> {
  try {
    const dto = await sendCommand('workstream-control', { workstreamId: id, action, ...(text ? { text } : {}) }, { awaitResult: true })
    if (!dto) throw new Error('the agent worker returned no workstream')
    return dto
  } catch (err) {
    throw workstreamError(err)
  }
}
