import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations, conversationMessages, channelDeliveries, agentRuns } from '../db/schema'
import type { ConversationDTO, ConversationMessageDTO, ConversationListItem, AttachmentRef, ToolCallRecordDTO, MessageUsage, MessageDeliveryDTO } from '../shared/types/conversation'
import type { AgentMessage, AgentContentPart } from '../lib/agent/run'
import type { AgentToolRecord } from '../lib/agent/tool-history'
import { TOOL_HISTORY_WINDOW } from '../lib/agent/tool-history'
import { buildUserMessageParts, withoutAttachmentMarkers } from '../lib/agent/attachments'
import { getImageBytes } from './images'
import { getFileBytes } from './files'
import { loadActivePath, type BranchInfo } from './conversation-path'
import { branchTip } from '../shared/utils/conversation-path'
import { eventModelText } from '../lib/agent/runtime/event-text'
import { publishChange } from '../utils/live-bus'
import type { DbTx } from '../lib/channels/outbox'

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
  role: 'user' | 'assistant' | 'event'
  content: string
  modality: 'voice' | 'text'
  toolCalls?: ToolCallRecordDTO[] | null
  reasoning?: string | null
  attachments?: AttachmentRef[] | null
  // Assistant-turn token usage from streamText, for the transcript's token readout.
  usage?: MessageUsage | null
  // Set for role='event' rows and wake-produced assistant rows — what caused them.
  origin?: string | null
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
    createdAt: r.createdAt.toISOString(),
    contextEpochAt: r.contextEpochAt ? r.contextEpochAt.toISOString() : null,
    kind: r.kind === 'main' ? 'main' : 'thread'
  }
}

/**
 * `branch` comes from `loadActivePath`; it is absent only for a row that was never in the
 * thread's grouping, which defaults to a lone trunk message — total 1 renders no pager, and
 * `[r.id]` keeps `siblingIds[branch.index - 1] === r.id` true for it too.
 */
export function msgToDTO(
  r: typeof conversationMessages.$inferSelect,
  branch?: BranchInfo,
  deliveries?: MessageDeliveryDTO[]
): ConversationMessageDTO {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant' | 'event',
    content: r.content,
    modality: r.modality as 'voice' | 'text',
    toolCalls: (r.toolCalls as ToolCallRecordDTO[] | null) ?? null,
    reasoning: r.reasoning ?? null,
    attachments: (r.attachments as AttachmentRef[] | null) ?? null,
    usage: (r.usage as MessageUsage | null) ?? null,
    createdAt: r.createdAt.toISOString(),
    parentId: r.parentId,
    branch: { index: branch?.index ?? 1, total: branch?.total ?? 1 },
    siblingIds: branch?.siblingIds ?? [r.id],
    origin: r.origin ?? null,
    ...(r.role === 'assistant' && deliveries?.length ? { deliveries } : {})
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
 * Returns `null` only while `branch_at_root` is set — an edit/regenerate of the FIRST message is
 * pending and this turn must start a new root (cycle 88). Only the web turn that edit belongs to
 * consumes it: a non-UI turn (wake, channel, job, workstream) passes `ignorePendingRoot` and chains
 * from the leaf the thread was on — see PENDING ROOT below.
 *
 * Returns `undefined`, NOT `null`, when the column is null (a conversation the leaf backfill
 * never reached, or a brand-new thread with no messages yet) — `appendMessages(id, msgs, null)`
 * means "start a NEW root", which would orphan every message the conversation already has.
 * `undefined` instead tells `appendMessages` to fall back to its own default (chain from
 * whatever leaf is active at persist time).
 */
export async function captureTurnLeaf(conversationId: string, opts: { ignorePendingRoot?: boolean } = {}): Promise<string | null | undefined> {
  const [conv] = await useDb().select({ leaf: conversations.activeLeafId, atRoot: conversations.branchAtRoot }).from(conversations)
    .where(eq(conversations.id, conversationId)).limit(1)
  // The one case where `null` IS the answer: an edit/regenerate of the first message is pending
  // (setBranchLeaf), so this turn must start a new root — a sibling of the old first message.
  if (conv?.atRoot && !opts.ignorePendingRoot) return null
  return conv?.leaf ?? undefined
}

// ---------------------------------------------------------------------------
// PENDING ROOT (cycle 88, review I4)
//
// `branch_at_root` = "an edit/regenerate of the FIRST message was PATCHed; the next WEB turn starts
// a second root". `active_leaf_id` is never moved by setting it, so clearing the flag is always an
// exact undo. The rules that keep it from sticking or hijacking a turn:
//   1. Only an append that STARTS a root clears it (appendMessages below). An append chained from
//      a real row — an event, a wake/channel turn, a turn rescued with its pre-edit leaf — lands on
//      the old branch and leaves the edit pending, so it cannot steal or cancel it.
//   2. Non-UI turns ignore it (captureTurnLeaf / getAgentHistory `ignorePendingRoot`): they read
//      and extend the branch the thread was on instead of running with zero history.
//   3. The web client cancels it (`cancelPendingRoot`, PATCH /leaf op:'restore') when the edit's
//      send fails.
//   4. A flag nobody consumed expires on the next conversation read (`expireStalePendingRoot`):
//      pending for longer than PENDING_ROOT_GRACE_MS with no queued/running run on the thread. A
//      live edit is PATCH → re-read → send within milliseconds, and once its run is queued the
//      run-exists guard protects it for however long it waits; the grace only covers the gap
//      before the run row exists. `updated_at` is the clock: setBranchLeaf writes it with the
//      flag, and any later write to the thread only makes the flag look younger (safe direction).
// ---------------------------------------------------------------------------

/** How long a first-message edit may sit unsent before a conversation read cancels it. */
export const PENDING_ROOT_GRACE_MS = 60_000

/** Cancel a pending first-message edit: the thread shows the branch it was on again. Returns
 *  whether a pending root was cleared. */
export async function cancelPendingRoot(conversationId: string): Promise<boolean> {
  const rows = await useDb().update(conversations).set({ branchAtRoot: false, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.branchAtRoot, true)))
    .returning({ id: conversations.id })
  return rows.length > 0
}

/** Rule 4 above. One conditional UPDATE, so it cannot race a send into clearing a live edit
 *  once that edit's run row exists. Returns whether it cleared anything (the caller publishes). */
export async function expireStalePendingRoot(conversationId: string, graceMs = PENDING_ROOT_GRACE_MS): Promise<boolean> {
  const rows = await useDb().update(conversations).set({ branchAtRoot: false })
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.branchAtRoot, true),
      sql`${conversations.updatedAt} < now() - make_interval(secs => ${graceMs / 1000})`,
      sql`not exists (select 1 from ${agentRuns} where ${agentRuns.conversationId} = ${conversations.id} and ${agentRuns.status} in ('queued', 'running'))`
    ))
    .returning({ id: conversations.id })
  return rows.length > 0
}

/**
 * Append messages as children of `parentId` and move the conversation's active leaf to the last
 * one inserted. Returns the inserted ids in insertion order — the rows of one call share a
 * created_at (one transaction's now()), so a caller cannot recover that order by reading back.
 *
 * `parentId` omitted → chain from the active leaf. `null` → start a NEW root (an explicit null
 * is not the same as no argument, which is why the check below is `!== undefined`).
 *
 * `opts.inTx` runs inside the same transaction, after the inserts and the leaf move, with the
 * new ids in insertion order — for writes that must commit or roll back with the messages
 * (cycle 75: a reply's channel deliveries). A throw there rolls the whole append back.
 */
export async function appendMessages(
  conversationId: string,
  msgs: NewConvMessage[],
  parentId?: string | null,
  opts: {
    inTx?: (tx: DbTx, ids: string[]) => Promise<void>
    /** Cycle 83 fix round 3: append INSIDE the caller's transaction (same connection) — e.g. while
     *  it holds the claim lock: a second pool connection could deadlock against it. */
    tx?: DbTx
  } = {}
): Promise<string[]> {
  if (!msgs.length) return []

  const db = opts.tx ?? useDb()

  // The parent is the ACTIVE LEAF, not the newest row. Once a branch exists those differ, and
  // chaining from the newest row would graft this turn onto whichever branch was written last
  // rather than the one the user is reading. The newest-row query this replaces also had no
  // tie-break, so among rows sharing a created_at (26% of this corpus) it picked arbitrarily
  // and unstably — see loadActivePath's `(created_at, id)` note.
  let prevId: string | null
  if (parentId !== undefined) {
    prevId = parentId
  } else {
    const [conv] = await db.select({ leaf: conversations.activeLeafId, atRoot: conversations.branchAtRoot }).from(conversations)
      .where(eq(conversations.id, conversationId)).limit(1)
    // NOT the pending-root flag: a default-parent append is an event row (a channel send, a job
    // outcome, a workstream note) — it extends the branch the thread is on and leaves a pending
    // first-message edit pending (PENDING ROOT rule 1). Only the web turn starts the new root,
    // and it passes `null` explicitly via captureTurnLeaf.
    prevId = conv?.leaf ?? null
  }
  // This append starts a root iff its first row has no parent — only then is a pending root made.
  const startsRoot = prevId === null

  // The inserts and the leaf move are ONE unit of work. Rows written without the matching
  // active_leaf_id are invisible to BOTH read paths — `loadActivePath` walks from the leaf and
  // never reaches them — so a crash between the two would silently lose the turn. That is a
  // failure mode this cycle introduces: before the leaf existed, the flat read still showed
  // them. Atomicity only — nothing here takes a lock or serializes concurrent appends.
  const ids: string[] = []
  const body = async (tx: DbTx) => {
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
          usage: msg.usage ?? null,
          origin: msg.origin ?? null
        })
        .returning({ id: conversationMessages.id })
      prevId = inserted!.id
      ids.push(prevId)
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
        activeLeafId: prevId,
        // A new root was just written, so a pending new-root branch (if any) has been made. An
        // append chained from a real row leaves the flag as it is (PENDING ROOT rule 1).
        ...(startsRoot ? { branchAtRoot: false } : {})
      })
      .where(eq(conversations.id, conversationId))

    if (opts.inTx) await opts.inTx(tx, [...ids])
  }
  if (opts.tx) await body(opts.tx)
  else await useDb().transaction(body)
  return ids
}

/** One event row on the active path — a wake, an approval note, a restart note. With `tx` it is
 *  written inside the caller's transaction, and the caller publishes the change after its commit. */
export async function appendEvent(conversationId: string, content: string, origin: string, o: { tx?: DbTx } = {}): Promise<void> {
  await appendMessages(conversationId, [{ role: 'event', content, modality: 'text', origin }], undefined, o.tx ? { tx: o.tx } : {})
  if (!o.tx) publishChange({ resource: 'conversation', action: 'updated', id: conversationId })
}

/**
 * Which message a new branch hangs from.
 *
 * fork      → the message itself: the new branch continues FROM there.
 * edit      → the message's parent: the edited version is a SIBLING of the original, so the
 *             original question and everything it produced stay reachable.
 * regenerate→ the reply's parent: same reasoning, applied to an assistant message.
 *
 * Returns `undefined` for a message that isn't in this conversation — the caller treats that as
 * "no branch to make" rather than a crash — and `null` for an edit or regenerate of a ROOT
 * message, whose new version is a second root. Two different answers, never one (cycle 88: the
 * single null this used to return for both is what kept first-message edits unsupported).
 */
export async function branchParent(
  conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
): Promise<string | null | undefined> {
  const [row] = await useDb()
    .select({ id: conversationMessages.id, parentId: conversationMessages.parentId })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.id, messageId)))
    .limit(1)
  if (!row) return undefined
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

  // Clearing branch_at_root is what makes the pager (and restoreLeaf) a way BACK out of a
  // pending first-message edit: switching to any row ends the empty-path state.
  await db.update(conversations).set({ activeLeafId: resolved, branchAtRoot: false, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  return resolved
}

/**
 * Undo a non-root branch move whose turn never went out, when the client cannot name the old
 * leaf: descend from the current leaf (the branch parent) to its newest tip, the same descent the
 * pager uses. Usually that is exactly the branch Tony was on (the unsent edit never wrote a
 * sibling); at worst it is a newer sibling branch — either way nothing is left hidden behind a
 * truncated path. Returns 'newest-branch', or null when the thread has no leaf at all.
 */
export async function restoreAfterUnsentBranch(conversationId: string): Promise<'newest-branch' | null> {
  const [conv] = await useDb().select({ leaf: conversations.activeLeafId }).from(conversations)
    .where(eq(conversations.id, conversationId)).limit(1)
  if (!conv?.leaf) return null
  return await setActiveLeaf(conversationId, conv.leaf) ? 'newest-branch' : null
}

/** setBranchLeaf's answer for an edit/regenerate of a root: no leaf, the next append is a new root. */
export const NEW_ROOT = 'new-root' as const

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
 * Returns the id actually written, `NEW_ROOT` for an edit/regenerate of a ROOT message (cycle 88:
 * the thread's `branch_at_root` flag is set — the active path is empty and the next append
 * starts a second root, which `active_leaf_id` alone cannot say because null there means "flat
 * read"), or null when `messageId` is not in this conversation (the caller 404s). Scoping is
 * `branchParent`'s: it selects the row under `conversationId`, and a parent of a row in this
 * conversation is in it too.
 */
export async function setBranchLeaf(
  conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
): Promise<string | typeof NEW_ROOT | null> {
  const db = useDb()
  const parent = await branchParent(conversationId, messageId, op)
  if (parent === undefined) return null

  if (parent === null) {
    // Edit/regenerate of a ROOT: the new version has no parent. The leaf stays where it is (a
    // real row, so restoreLeaf / the pager can always get back) and the flag empties the path.
    // updated_at on the POSTGRES clock: expireStalePendingRoot compares it against now().
    await db.update(conversations).set({ branchAtRoot: true, updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId))
    return NEW_ROOT
  }

  await db.update(conversations).set({ activeLeafId: parent, branchAtRoot: false, updatedAt: new Date() })
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

  // PENDING ROOT rule 4: a first-message edit that was never sent must not blank the thread.
  if (conv.branchAtRoot && await expireStalePendingRoot(id)) {
    conv.branchAtRoot = false
    publishChange({ resource: 'conversation', action: 'updated', id })
  }

  // The active branch only — the same walk `getAgentHistory` uses, so the transcript the user
  // reads and the context the model gets can never be two different conversations.
  const { rows: msgs, branches } = await loadActivePath(id)

  const deliveries = await deliveriesByMessage(msgs.filter(m => m.role === 'assistant').map(m => m.id))

  return {
    conversation: convToDTO(conv),
    messages: msgs.map(m => msgToDTO(m, branches.get(m.id), deliveries.get(m.id)))
  }
}

/** Channel deliveries (cycle 75) of the given messages, grouped by message id — one query. */
export async function deliveriesByMessage(messageIds: string[]): Promise<Map<string, MessageDeliveryDTO[]>> {
  const out = new Map<string, MessageDeliveryDTO[]>()
  if (!messageIds.length) return out
  const rows = await useDb()
    .select({ messageId: channelDeliveries.messageId, channel: channelDeliveries.channel, status: channelDeliveries.status })
    .from(channelDeliveries)
    // One array parameter, however long the thread (main is permanent): no per-id bind params.
    .where(sql`${channelDeliveries.messageId} = any(${sql.param(messageIds)}::uuid[])`)
    .orderBy(channelDeliveries.createdAt)
  for (const r of rows) {
    if (!r.messageId) continue
    const list = out.get(r.messageId) ?? []
    list.push({ channel: r.channel as MessageDeliveryDTO['channel'], status: r.status })
    out.set(r.messageId, list)
  }
  return out
}

/** Every delivery of a reply in one conversation, for the live badge refresh in /agent. */
export async function conversationDeliveries(conversationId: string): Promise<({ messageId: string } & MessageDeliveryDTO)[]> {
  const rows = await useDb()
    .select({ messageId: channelDeliveries.messageId, channel: channelDeliveries.channel, status: channelDeliveries.status })
    .from(channelDeliveries)
    .where(and(eq(channelDeliveries.conversationId, conversationId), isNotNull(channelDeliveries.messageId)))
    .orderBy(channelDeliveries.createdAt)
  return rows.map(r => ({ messageId: r.messageId!, channel: r.channel as MessageDeliveryDTO['channel'], status: r.status }))
}

/** Row → AgentMessage. Never throws: a malformed tool_calls jsonb yields no records. */
export function rowToAgentMessage(
  r: { role: string; content: string; toolCalls: unknown; attachments: unknown; origin?: string | null }
): AgentMessage {
  if (r.role === 'event') return { role: 'user', content: eventModelText(r.origin ?? null, r.content) } as AgentMessage
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

export async function getAgentHistory(id: string, opts: { ignorePendingRoot?: boolean } = {}): Promise<AgentMessage[]> {
  return (await loadAgentHistory(id, opts)).messages
}

/** getAgentHistory plus the path's `summaryApplies`, so a turn's context assembly can decide the
 *  summary tier without walking the whole thread a second time (review M1). */
export async function loadAgentHistory(id: string, opts: { ignorePendingRoot?: boolean } = {}): Promise<{ messages: AgentMessage[], summaryApplies: boolean }> {
  // Same active-path walk as `getConversation` — see test/conversation-path.db.test.ts — but
  // WITH `sinceEpoch: true`. This is the one deliberate divergence between the two read paths:
  // `/clear` (server/services/conversation-clear.ts) sets `conversations.context_epoch_at`, and
  // only the MODEL forgets what came before it — the UI keeps showing the full transcript. Do
  // not "fix" this back to matching `getConversation`; see test/conversation-epoch.db.test.ts
  // for the test that pins the asymmetry.
  //
  // Also WITH `sinceSummary: true` — rows the summary covers reach the model as the summary
  // tier (assembleContext), not verbatim.
  //
  // `ignorePendingRoot`: a non-UI turn reads the branch the thread was on (PENDING ROOT rule 2).
  const { rows, summaryApplies } = await loadActivePath(id, { sinceEpoch: true, sinceSummary: true, ignorePendingRoot: opts.ignorePendingRoot })

  const msgs = rows.map(rowToAgentMessage)

  // A missing blob, an unreadable file, or any other thrown error must never break resume —
  // fall back to the un-hydrated (plain-text) messages rather than propagating.
  try {
    return {
      messages: await hydrateAttachments(
        msgs,
        rows,
        (a: AttachmentRef) => (a.kind === 'image' ? getImageBytes(a.id) : getFileBytes(a.id))
      ),
      summaryApplies
    }
  } catch {
    return { messages: msgs, summaryApplies }
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
    .orderBy(sql`(${conversations.kind} = 'main') desc`, sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(50)

  return rows.map(r => ({
    ...convToDTO(r),
    snippet: null
  }))
}

export async function deleteConversation(id: string): Promise<void> {
  // Cycle 83 (ruling I2): a coordinator's thread takes its workstream row with it (FK cascade) and its
  // children's parent_id goes NULL — cancel those children first, inside the tree. Never blocks the
  // delete: the worker's sweep cancels any child left without a coordinator.
  try {
    const { cancelChildrenOfThread } = await import('../lib/agent/workstreams/coordinator')
    await cancelChildrenOfThread(id)
  } catch (err) { console.error('[conversations] cancelling a coordinator\'s children failed:', err) }
  // cascade delete on conversation_messages is set via FK onDelete: 'cascade'
  await useDb()
    .delete(conversations)
    .where(eq(conversations.id, id))
}
