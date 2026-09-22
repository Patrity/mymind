import { and, eq, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations, conversationMessages } from '../db/schema'
import type { ConversationDTO, ConversationMessageDTO, ConversationListItem, AttachmentRef, ToolCallRecordDTO, MessageUsage } from '../../shared/types/conversation'
import type { AgentMessage, AgentContentPart } from '../lib/agent/run'
import type { AgentToolRecord } from '../lib/agent/tool-history'
import { TOOL_HISTORY_WINDOW } from '../lib/agent/tool-history'
import { buildUserMessageParts, withoutAttachmentMarkers } from '../lib/agent/attachments'
import { getImageBytes } from './images'
import { getFileBytes } from './files'
import { loadActivePath, type BranchInfo } from './conversation-path'
import { branchTip } from '../../shared/utils/conversation-path'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'New conversation'
  return t.length <= 60 ? t : t.slice(0, 59).trimEnd() + '…'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewConvMessage {
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls?: ToolCallRecordDTO[] | null
  reasoning?: string | null
  attachments?: AttachmentRef[] | null
  // Assistant-turn token usage from streamText, for the transcript's token readout.
  usage?: MessageUsage | null
}

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

function convToDTO(r: typeof conversations.$inferSelect): ConversationDTO {
  return {
    id: r.id,
    title: r.title ?? null,
    projectId: r.projectId ?? null,
    messageCount: r.messageCount,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    createdAt: r.createdAt.toISOString()
  }
}

/**
 * `branch` comes from `loadActivePath`; it is absent only for a row that was never in the
 * thread's grouping, which defaults to a lone trunk message — total 1 renders no pager, and
 * `[r.id]` keeps `siblingIds[branch.index - 1] === r.id` true for it too.
 */
export function msgToDTO(
  r: typeof conversationMessages.$inferSelect,
  branch?: BranchInfo
): ConversationMessageDTO {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    modality: r.modality as 'voice' | 'text',
    toolCalls: (r.toolCalls as ToolCallRecordDTO[] | null) ?? null,
    reasoning: r.reasoning ?? null,
    attachments: (r.attachments as AttachmentRef[] | null) ?? null,
    usage: (r.usage as MessageUsage | null) ?? null,
    createdAt: r.createdAt.toISOString(),
    parentId: r.parentId,
    branch: { index: branch?.index ?? 1, total: branch?.total ?? 1 },
    siblingIds: branch?.siblingIds ?? [r.id]
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function createConversation(
  input?: { title?: string | null; projectId?: string | null }
): Promise<ConversationDTO> {
  const [row] = await useDb()
    .insert(conversations)
    .values({
      title: input?.title ?? null,
      projectId: input?.projectId ?? null
    })
    .returning()
  return convToDTO(row!)
}

/**
 * The active leaf for a conversation, read NOW rather than at persist time.
 *
 * A caller with a long-running operation between "the turn started" and "the turn persists"
 * (server/api/voice/ws.ts's WS turn is the motivating case) needs to freeze which branch it's
 * writing into before `active_leaf_id` can move out from under it — PATCH
 * `/api/conversations/:id/leaf` lets another tab, or the same user switching branches mid-reply,
 * change that column while the turn is still running. Call this once, up front, and pass the
 * result straight through as `appendMessages`' `parentId`.
 *
 * Returns `undefined`, NOT `null`, when the column is null (a conversation the leaf backfill
 * never reached, or a brand-new thread with no messages yet) — `appendMessages(id, msgs, null)`
 * means "start a NEW root", which would orphan every message the conversation already has.
 * `undefined` instead tells `appendMessages` to fall back to its own default (chain from
 * whatever leaf is active at persist time).
 */
export async function captureTurnLeaf(conversationId: string): Promise<string | undefined> {
  const [conv] = await useDb().select({ leaf: conversations.activeLeafId }).from(conversations)
    .where(eq(conversations.id, conversationId)).limit(1)
  return conv?.leaf ?? undefined
}

/**
 * Append messages as children of `parentId` and move the conversation's active leaf to the last
 * one inserted.
 *
 * `parentId` omitted → chain from the active leaf. `null` → start a NEW root (an explicit null
 * is not the same as no argument, which is why the check below is `!== undefined`).
 */
export async function appendMessages(
  conversationId: string,
  msgs: NewConvMessage[],
  parentId?: string | null
): Promise<void> {
  if (!msgs.length) return

  const db = useDb()

  // The parent is the ACTIVE LEAF, not the newest row. Once a branch exists those differ, and
  // chaining from the newest row would graft this turn onto whichever branch was written last
  // rather than the one the user is reading. The newest-row query this replaces also had no
  // tie-break, so among rows sharing a created_at (26% of this corpus) it picked arbitrarily
  // and unstably — see loadActivePath's `(created_at, id)` note.
  let prevId: string | null
  if (parentId !== undefined) {
    prevId = parentId
  } else {
    const [conv] = await db.select({ leaf: conversations.activeLeafId }).from(conversations)
      .where(eq(conversations.id, conversationId)).limit(1)
    prevId = conv?.leaf ?? null
  }

  // The inserts and the leaf move are ONE unit of work. Rows written without the matching
  // active_leaf_id are invisible to BOTH read paths — `loadActivePath` walks from the leaf and
  // never reaches them — so a crash between the two would silently lose the turn. That is a
  // failure mode this cycle introduces: before the leaf existed, the flat read still showed
  // them. Atomicity only — nothing here takes a lock or serializes concurrent appends.
  await db.transaction(async (tx) => {
    // Insert each message in order, chaining parentId linearly
    for (const msg of msgs) {
      const [inserted] = await tx
        .insert(conversationMessages)
        .values({
          conversationId,
          parentId: prevId,
          role: msg.role,
          content: msg.content,
          modality: msg.modality,
          toolCalls: msg.toolCalls ?? null,
          reasoning: msg.reasoning ?? null,
          attachments: msg.attachments ?? null,
          usage: msg.usage ?? null
        })
        .returning({ id: conversationMessages.id })
      prevId = inserted!.id
    }

    // Bump conversation stats, and move the leaf onto what was just written — `prevId` is the
    // last inserted id after the loop. Without this the branch just appended to would be
    // unreachable by either read path, and the next append would chain from the old leaf.
    const now = new Date()
    await tx
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + ${msgs.length}`,
        lastMessageAt: now,
        updatedAt: now,
        activeLeafId: prevId
      })
      .where(eq(conversations.id, conversationId))
  })
}

/**
 * Which message a new branch hangs from.
 *
 * fork      → the message itself: the new branch continues FROM there.
 * edit      → the message's parent: the edited version is a SIBLING of the original, so the
 *             original question and everything it produced stay reachable.
 * regenerate→ the reply's parent: same reasoning, applied to an assistant message.
 *
 * Returns null for a message that isn't in this conversation — the caller treats that as "no
 * branch to make" rather than a crash. Note null is also the legitimate answer for an edit or
 * regenerate of a ROOT message, which correctly makes the new version a second root.
 */
export async function branchParent(
  conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
): Promise<string | null> {
  const [row] = await useDb()
    .select({ id: conversationMessages.id, parentId: conversationMessages.parentId })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.id, messageId)))
    .limit(1)
  if (!row) return null
  return op === 'fork' ? row.id : row.parentId
}

/**
 * Point the thread at a different branch — the CHOSEN sibling's branch tip, not the sibling
 * itself. The client only ever fetches the active path, so it has no way to know an inactive
 * sibling has its own continuation; landing the leaf on the sibling itself would make everything
 * below the switch point invisible to both read paths (see shared/utils/conversation-path's
 * branchTip).
 *
 * Returns the resolved leaf id, or null when `leafId` is not a message in THIS conversation —
 * the caller 404s rather than silently pointing a thread at someone else's message. The rows
 * query is scoped to `conversationId`, which is what makes that scoping guard real: an id from
 * another conversation is simply absent from `rows`, so `branchTip` can't find it.
 */
export async function setActiveLeaf(conversationId: string, leafId: string): Promise<string | null> {
  const db = useDb()
  // Same tie-break as loadActivePath's query — branchTip's own sort is the actual authority on
  // sibling order, but ordering this query too keeps the two functions from differing for no
  // reason, and `id` breaks a created_at tie deterministically either way.
  const rows = await db.select({
    id: conversationMessages.id,
    parentId: conversationMessages.parentId,
    createdAt: conversationMessages.createdAt
  }).from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(conversationMessages.createdAt, conversationMessages.id)

  const resolved = branchTip(rows, leafId)
  if (!resolved) return null

  await db.update(conversations).set({ activeLeafId: resolved, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  return resolved
}

/**
 * Is this message in this conversation?
 *
 * Exists only to tell two different `null`s apart on the branch error path (see
 * leaf.patch.ts): `branchParent` answers null both for "not in this conversation" and for
 * "this IS the conversation's root", and the second must not be reported as the first.
 */
export async function conversationHasMessage(conversationId: string, messageId: string): Promise<boolean> {
  const [row] = await useDb()
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.id, messageId)))
    .limit(1)
  return !!row
}

/**
 * Point the thread where a NEW branch should hang from — `branchParent`'s answer, set EXACTLY,
 * with no `branchTip` descent.
 *
 * The descent in `setActiveLeaf` above is right for switching to an existing sibling ("resume
 * that branch where I left it") and wrong for every branch-creating op. A fork is the clearest
 * case: `setActiveLeaf(conv, M)` descends straight back to the branch's tip, so the next turn
 * chains onto the end of the thread — "carry on as normal", which is the exact opposite of a
 * fork. Edit and regenerate would descend off their target's parent in the same way.
 *
 * Returns the id actually written, or null when `messageId` is not in this conversation — or
 * when `branchParent` answers null because the target is a ROOT (an edit/regenerate of the very
 * first message would have to hang off "no parent", and `conversations.active_leaf_id` has no
 * way to say "start a second root"; the caller 404s). Scoping is `branchParent`'s: it selects
 * the row under `conversationId`, and a parent of a row in this conversation is in it too.
 */
export async function setBranchLeaf(
  conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
): Promise<string | null> {
  const parent = await branchParent(conversationId, messageId, op)
  if (!parent) return null

  await useDb().update(conversations).set({ activeLeafId: parent, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  return parent
}

export async function getConversation(
  id: string
): Promise<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] } | null> {
  const db = useDb()

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)

  if (!conv) return null

  // The active branch only — the same walk `getAgentHistory` uses, so the transcript the user
  // reads and the context the model gets can never be two different conversations.
  const { rows: msgs, branches } = await loadActivePath(id)

  return {
    conversation: convToDTO(conv),
    messages: msgs.map(m => msgToDTO(m, branches.get(m.id)))
  }
}

/** Row → AgentMessage. Never throws: a malformed tool_calls jsonb yields no records. */
export function rowToAgentMessage(
  r: { role: string; content: string; toolCalls: unknown; attachments: unknown }
): AgentMessage {
  const base = { role: r.role as 'user' | 'assistant', content: r.content }
  if (r.role !== 'assistant' || !Array.isArray(r.toolCalls) || !r.toolCalls.length) return base as AgentMessage
  return { ...base, role: 'assistant', toolRecords: r.toolCalls as AgentToolRecord[] } as AgentMessage
}

/**
 * `buildUserMessageParts` (live-turn code, unmodified here) degrades a single failed read to
 * an `[attachment unavailable…]` text note. That's fine for a ONE-SHOT live turn, but
 * `hydrateAttachments` re-runs it on every `getAgentHistory` call — a durably-missing blob
 * would otherwise re-inject that note into replayed history on every resume, which is the
 * same repeating-marker-in-history shape as the `[image]` imitation bug. Strip it here, on
 * the resume path only, so a failed within-window read degrades the same way an
 * out-of-window turn does: silently. If nothing usable survives the strip (no text, no
 * other attachment), fall back to the plain text content rather than an empty parts array.
 */
function stripUnavailableMarkers(
  content: string | AgentContentPart[],
  fallbackText: string
): string | AgentContentPart[] {
  if (typeof content === 'string') return content
  const filtered = withoutAttachmentMarkers(content) as AgentContentPart[]
  return filtered.length ? filtered : fallbackText
}

/**
 * Re-attach image/file bytes to the most recent user turns so a resumed agent can still SEE
 * them. Older turns degrade to plain text with NO placeholder — a marker is exactly the
 * artifact cycle 39 removed, and reintroducing one here would re-open the imitation bug.
 */
export async function hydrateAttachments(
  msgs: AgentMessage[],
  rows: { role: string; attachments: unknown }[],
  readBytes: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
): Promise<AgentMessage[]> {
  const withAttachments = rows
    .map((r, i) => (r.role === 'user' && Array.isArray(r.attachments) && r.attachments.length ? i : -1))
    .filter(i => i >= 0)
  const keep = new Set(withAttachments.slice(-TOOL_HISTORY_WINDOW))

  return Promise.all(msgs.map(async (m, i) => {
    if (!keep.has(i)) return m
    const refs = rows[i]!.attachments as AttachmentRef[]
    // Clean the STORED text before it re-enters: rows written before markers were stripped at
    // the persist boundary carry them inline, where they are no longer their own part and the
    // part-level filter below can never reach them. This also keeps `fallbackText` marker-free,
    // so the empty-parts fallback cannot hand a marker straight back.
    const text = withoutAttachmentMarkers(m.content as string) as string
    const built = await buildUserMessageParts(text, refs, readBytes)
    return { ...m, content: stripUnavailableMarkers(built, text) }
  }))
}

export async function getAgentHistory(id: string): Promise<AgentMessage[]> {
  // Same walk as `getConversation` — see test/conversation-path.db.test.ts. If these two ever
  // select rows independently, the model answers a branch nobody is looking at and the UI
  // shows nothing wrong.
  const { rows } = await loadActivePath(id)

  const msgs = rows.map(rowToAgentMessage)

  // A missing blob, an unreadable file, or any other thrown error must never break resume —
  // fall back to the un-hydrated (plain-text) messages rather than propagating.
  try {
    return await hydrateAttachments(
      msgs,
      rows,
      (a: AttachmentRef) => (a.kind === 'image' ? getImageBytes(a.id) : getFileBytes(a.id))
    )
  } catch {
    return msgs
  }
}

export async function listConversations(
  opts?: { q?: string }
): Promise<ConversationListItem[]> {
  const db = useDb()
  const q = opts?.q?.trim()

  const whereClause = q
    ? or(
        sql`${conversations.title} ilike ${'%' + q + '%'}`,
        sql`${conversations.id} in (select conversation_id from ${conversationMessages} where ${conversationMessages.content} ilike ${'%' + q + '%'})`
      )
    : undefined

  const rows = await db
    .select()
    .from(conversations)
    .where(whereClause)
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(50)

  return rows.map(r => ({
    ...convToDTO(r),
    snippet: null
  }))
}

export async function deleteConversation(id: string): Promise<void> {
  // cascade delete on conversation_messages is set via FK onDelete: 'cascade'
  await useDb()
    .delete(conversations)
    .where(eq(conversations.id, id))
}
