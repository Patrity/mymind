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
}

export interface RunOutcome {
  status: 'done' | 'failed' | 'aborted'
  suppressed?: boolean
  error?: string
  usage?: Record<string, unknown> | null
  userMessageId?: string
  assistantMessageId?: string
}
