// Pure helpers used on BOTH sides of the wire, so the live stream and a resumed thread
// derive tool state and attachment parts identically (the parity test depends on it).
import type { FileUIPart } from 'ai'
import type { AttachmentRef } from '../types/conversation'
import type { AgentToolKind, ToolEnvelope } from '../types/agent-ui'

export type ToolOutcome = { state: 'ok' } | { state: 'error'; errorText: string } | { state: 'denied' }

/** How a finished call ended, read from what ai-tools returns: a thrown handler → `{ error }`,
 *  an exec denial → `{ denied: true }`. Anything else is a normal result. */
export function toolOutcome(result: unknown): ToolOutcome {
  if (result && typeof result === 'object') {
    const r = result as { denied?: unknown; error?: unknown }
    if (r.denied === true) return { state: 'denied' }
    if (typeof r.error === 'string') return { state: 'error', errorText: r.error }
  }
  return { state: 'ok' }
}

export function toolEnvelope(o: { result: unknown; summary: string; undoToken?: string; kind?: AgentToolKind }): ToolEnvelope {
  return {
    value: o.result,
    summary: o.summary,
    ...(o.undoToken ? { undoToken: o.undoToken } : {}),
    ...(o.kind ? { kind: o.kind } : {})
  }
}

export function attachmentUrl(a: AttachmentRef): string {
  return a.kind === 'image' ? `/api/images/${a.id}/raw` : `/api/agent/files/${a.id}`
}

export function attachmentToFilePart(a: AttachmentRef): FileUIPart {
  return { type: 'file', mediaType: a.mime, url: attachmentUrl(a), ...(a.name ? { filename: a.name } : {}) }
}
