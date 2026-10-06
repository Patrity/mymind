// server/lib/google/gmail.ts
// Thin Gmail REST wrappers (users/me) over the shared google() client. Every call carries the
// caller's GoogleDeps so tests drive the transport with fakeFetch. No formatting here — the
// agent tools (server/lib/agent/tools/gmail.ts) decide what the model sees.

import { google, type GoogleDeps } from './client'
import type { Connection } from './connections'
import { header, type GmailPayload } from './mime'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
/** Upper bound on parallel per-thread metadata fetches in one search (limit is ≤20 anyway). */
const MAX_THREADS = 20

export interface GmailMessage {
  id: string
  threadId?: string
  internalDate?: string
  labelIds?: string[]
  snippet?: string
  payload?: GmailPayload
}

export interface GmailThread {
  id: string
  snippet?: string
  messages?: GmailMessage[]
}

export interface GmailDraft {
  id: string
  message?: GmailMessage & { raw?: string }
}

export interface GmailLabel {
  id: string
  name: string
  type?: string
}

export interface ThreadSummary {
  threadId: string
  from: string
  subject: string
  /** epoch ms of the newest message (for sorting / rendering in agent tz) */
  dateMs: number
  snippet: string
  unread: boolean
  labels: string[]
}

function summarize(t: GmailThread, fallbackSnippet?: string): ThreadSummary {
  const msgs = t.messages ?? []
  const first = msgs[0]
  const last = msgs[msgs.length - 1]
  const labels = [...new Set(msgs.flatMap(m => m.labelIds ?? []))]
  const subject = (first?.payload && header(first.payload, 'Subject'))
    ?? (last?.payload && header(last.payload, 'Subject')) ?? ''
  return {
    threadId: t.id,
    from: (last?.payload && header(last.payload, 'From')) ?? '',
    subject,
    dateMs: Number(last?.internalDate ?? 0) || 0,
    snippet: last?.snippet ?? fallbackSnippet ?? t.snippet ?? '',
    unread: labels.includes('UNREAD'),
    labels
  }
}

/** `GET /threads?q` then each thread's From/Subject/Date metadata in parallel. A thread that
 *  vanished between the list and its fetch is skipped; if EVERY fetch fails the first error is
 *  thrown (so fanOut reports the account rather than silently returning nothing). */
export async function searchThreads(c: Connection, q: string, limit: number, deps: GoogleDeps = {}): Promise<ThreadSummary[]> {
  const g = google(c, deps)
  const list = await g.get<{ threads?: { id: string, snippet?: string }[] }>(`${BASE}/threads`, { q, maxResults: limit })
  const ids = (list.threads ?? []).slice(0, Math.min(limit, MAX_THREADS))
  if (ids.length === 0) return []
  const settled = await Promise.allSettled(ids.map(t => g.get<GmailThread>(`${BASE}/threads/${encodeURIComponent(t.id)}`, {
    format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date']
  })))
  const out: ThreadSummary[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out.push(summarize(s.value, ids[i]!.snippet))
  })
  if (out.length === 0) {
    const firstErr = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined
    if (firstErr) throw firstErr.reason
  }
  return out
}

export async function getThread(
  c: Connection, id: string, deps: GoogleDeps = {},
  opts: { format?: 'full' | 'metadata', metadataHeaders?: string[] } = {}
): Promise<GmailThread> {
  return google(c, deps).get<GmailThread>(`${BASE}/threads/${encodeURIComponent(id)}`, {
    format: opts.format ?? 'full', metadataHeaders: opts.metadataHeaders
  })
}

export async function createDraft(c: Connection, raw: string, threadId?: string, deps: GoogleDeps = {}): Promise<GmailDraft> {
  return google(c, deps).post<GmailDraft>(`${BASE}/drafts`, { message: { raw, ...(threadId ? { threadId } : {}) } })
}

export async function updateDraft(c: Connection, draftId: string, raw: string, threadId?: string, deps: GoogleDeps = {}): Promise<GmailDraft> {
  return google(c, deps).put<GmailDraft>(`${BASE}/drafts/${encodeURIComponent(draftId)}`, {
    id: draftId, message: { raw, ...(threadId ? { threadId } : {}) }
  })
}

export async function deleteDraft(c: Connection, draftId: string, deps: GoogleDeps = {}): Promise<void> {
  await google(c, deps).del(`${BASE}/drafts/${encodeURIComponent(draftId)}`)
}

/** `format: 'full'` gives a parseable payload (what an approval card shows); `'raw'` gives the
 *  exact RFC 2822 bytes (what an update's undo restores). */
export async function getDraft(c: Connection, draftId: string, deps: GoogleDeps = {}, format: 'full' | 'raw' = 'full'): Promise<GmailDraft> {
  return google(c, deps).get<GmailDraft>(`${BASE}/drafts/${encodeURIComponent(draftId)}`, { format })
}

export async function sendDraft(c: Connection, draftId: string, deps: GoogleDeps = {}): Promise<GmailMessage> {
  return google(c, deps).post<GmailMessage>(`${BASE}/drafts/send`, { id: draftId })
}

export async function listLabels(c: Connection, deps: GoogleDeps = {}): Promise<GmailLabel[]> {
  const res = await google(c, deps).get<{ labels?: GmailLabel[] }>(`${BASE}/labels`)
  return res.labels ?? []
}

export async function modifyThread(c: Connection, id: string, add: string[], remove: string[], deps: GoogleDeps = {}): Promise<void> {
  await google(c, deps).post(`${BASE}/threads/${encodeURIComponent(id)}/modify`, { addLabelIds: add, removeLabelIds: remove })
}
