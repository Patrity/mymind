import type { AttachmentRef } from '../../../../shared/types/conversation'

export type SessionKey = 'main' | `thread:${string}` | `isolated:${string}`
export type RunTrigger = 'user' | 'wake'
export type RunProfile = 'interactive' | 'headless'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'aborted'

export interface RunInput {
  text: string
  modality: 'text' | 'voice'
  attachments?: AttachmentRef[]
  skill?: string
  speak?: boolean
  presetId?: string | null
  /** 'light' = only the last few turns of history (cycle 74 jobs); absent/'full' = today's behaviour. */
  context?: 'light' | 'full'
  /** Cycle 75: where the message came from (e.g. `imessage:<chatGuid>`), stamped on the persisted
   *  user row so the UI can mark it. Absent for app-typed messages. */
  origin?: string
  /** Cycle 78: toolsets a job declared; loaded at run start. */
  toolsets?: string[]
}

/** Cycle 75: where to send this run's reply besides the web UI — set when the run was
 *  woken by an inbound iMessage, so the answer routes back to the sender's chat. */
export interface ReplyTo { channel: 'imessage'; chatGuid: string; messageGuid: string }

export interface RunOutcome {
  status: 'done' | 'failed' | 'aborted'
  suppressed?: boolean
  error?: string
  usage?: Record<string, unknown> | null
  userMessageId?: string
  assistantMessageId?: string
  /** Set by queue.ts execute() when an 'aborted' run was stopped by its headless wall clock rather
   *  than by Tony (Stop / clear). Job outcomes count only the former toward auto-disable. */
  timedOut?: boolean
}
