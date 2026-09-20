import type { SessionToolEventDTO } from '~~/shared/types/session'

export interface SessionToolView {
  state: 'output-available' | 'output-error'
  input: unknown
  output: unknown
}

/**
 * /agent renders AI SDK tool parts, whose `state` is a machine (input-available →
 * output-available / output-error). An ingested session tool event has `exitStatus`
 * instead. This bridges the two so the Elements <Tool> components can be reused verbatim,
 * rather than SessionTranscript growing a second tool-rendering dialect.
 *
 * A session's events are always terminal — they were recorded after the fact — so there is
 * no running state to represent.
 */
const ERROR_STATUSES = new Set(['error', 'failure', 'failed'])

export function sessionToolState(event: SessionToolEventDTO): SessionToolView {
  const status = event.exitStatus?.toLowerCase()
  return {
    state: status && ERROR_STATUSES.has(status) ? 'output-error' : 'output-available',
    input: event.args,
    output: event.result
  }
}
