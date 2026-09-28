// server/lib/channels/inbound.ts
// Inbound iMessage (spec §4): one BlueBubbles message → at most one turn on main.
//
// The webhook and the periodic catch-up both feed handleInbound. Which of them wins when the
// same message arrives both ways at once is decided by the primary-key insert on
// channel_inbound.guid (Review Focus 3): exactly one insert returns a row, and only that caller
// enqueues. `enqueue` opens its own DB work (resolveSession, createRun) and cannot join a
// transaction, so the dedupe row is inserted first and deleted again if the enqueue throws —
// the message then stays eligible for the next catch-up instead of being lost.
//
// catchUpTick doubles as the BlueBubbles health check (lastHealth) and confirms outbound
// deliveries left `sent_unconfirmed` by an AppleScript send that timed out.
import { and, asc, eq, inArray, max, type SQL } from 'drizzle-orm'
import { useDb } from '../../db'
import { channelDeliveries, channelInbound } from '../../db/schema'
import { createImage, deleteImage } from '../../services/images'
import { withFailover } from '../ai/registry/resolve'
import { sttFromModel } from '../voice/providers'
import { recordEvent } from '../observability/record'
import { publishChange } from '../../utils/live-bus'
import { enqueue } from '../agent/runtime/queue'
import type { ReplyTo } from '../agent/runtime/types'
import type { AttachmentRef } from '../agent/attachments'
import { loadChannelsConfig } from './config'
import { isAllowed, maskHandle } from './handles'
import { resolveTapback, expireApprovals } from './approvals'
import { imessageClient, BlueBubblesError, type BlueBubblesClient } from './bluebubbles/client'
import { parseBlueBubblesMessage } from './bluebubbles/parse'
import type { InboundAttachment, InboundMessage, TapbackEvent } from './types'

export type InboundOutcome =
  | 'enqueued' | 'duplicate'
  | 'ignored:from-me' | 'ignored:group' | 'ignored:sender' | 'ignored:empty' | 'ignored:reaction'
  | 'tapback'

export type Transcribe = (audio: Uint8Array, opts: { mime: string; filename: string }) => Promise<string>

export interface InboundDeps {
  enqueueFn?: typeof enqueue
  /** The BlueBubbles client for downloads; omitted → imessageClient(). */
  client?: BlueBubblesClient | null
  /** Test seam: this conversation stands in for main (enqueued as `thread:<id>`). */
  mainConversationId?: string
  /** STT seam; default is the `stt` failover chain. */
  transcribe?: Transcribe
}

export const CATCH_UP_INTERVAL_MS = 120_000
export const CATCH_UP_OVERLAP_MS = 300_000
/** With no inbound history yet, catch-up starts this far back. */
const CATCH_UP_FIRST_LOOKBACK_MS = 3_600_000
const CATCH_UP_PAGE = 100
const CATCH_UP_MAX_PAGES = 10

const MAX_IMAGES = 4
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const HEIC = /^image\/hei[cf]$/i

const PHOTO_FAILED = "(couldn't load the photo)"
const VOICE_FAILED = "(a voice memo I couldn't transcribe)"

/** An unconfirmed image-only send can't be matched by text; after this long it counts as sent. */
const IMAGE_CONFIRM_AFTER_MS = 600_000
/** An unconfirmed send still not found after this long is given up on. */
const UNCONFIRMED_GIVE_UP_MS = 86_400_000
/** How far before `firstClaimedAt` an own message still counts (clock skew between hosts). */
const OWN_MESSAGE_LOOKBACK_MS = 5_000
const CONFIRM_BATCH = 50

const defaultTranscribe: Transcribe = (audio, opts) => withFailover('stt', m => sttFromModel(m).transcribe(audio, opts))

async function alreadySeen(guid: string): Promise<boolean> {
  const [row] = await useDb().select({ guid: channelInbound.guid }).from(channelInbound).where(eq(channelInbound.guid, guid)).limit(1)
  return !!row
}

/** Record a GUID with no run. True when this call inserted it (first sighting). */
async function recordGuid(ev: InboundMessage): Promise<boolean> {
  const rows = await useDb().insert(channelInbound)
    .values({ guid: ev.guid, channel: 'imessage', sender: ev.sender, receivedAt: ev.date })
    .onConflictDoNothing().returning({ guid: channelInbound.guid })
  return rows.length > 0
}

async function discardImages(refs: AttachmentRef[]): Promise<void> {
  for (const r of refs) await deleteImage(r.id).catch(err => console.warn(`[channels] discarding image ${r.id} failed:`, err))
}

interface BuiltInput { text: string; attachments: AttachmentRef[] }

async function loadPhoto(client: BlueBubblesClient | null, a: InboundAttachment): Promise<AttachmentRef | null> {
  if (!client) return null
  try {
    // Downloaded with BlueBubbles' conversion, so HEIC normally arrives as JPEG; if it is still
    // HEIC the vision model can't read it, so it becomes a note instead (Review Focus 1).
    const dl = await client.downloadAttachment(a.guid)
    if (HEIC.test(dl.mime) || dl.data.length > MAX_ATTACHMENT_BYTES) return null
    const row = await createImage(dl.data, dl.mime, dl.name || a.name || undefined)
    publishChange({ resource: 'image', action: 'created', id: row.id })
    return { id: row.id, kind: 'image', mime: row.mime, ...(row.originalName ? { name: row.originalName } : {}) }
  } catch (err) {
    console.warn(`[channels] inbound photo ${a.guid} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

async function transcribeMemo(client: BlueBubblesClient | null, a: InboundAttachment, transcribe: Transcribe): Promise<string | null> {
  if (!client) return null
  try {
    const dl = await client.downloadAttachment(a.guid)
    if (dl.data.length > MAX_ATTACHMENT_BYTES) return null
    // Label the upload with what the bytes really are (a `.caf` memo is audio/x-caf, never WAV;
    // Review Focus 2) — the downloaded type when it is audio, else the attachment's own.
    const mime = dl.mime.startsWith('audio/') ? dl.mime : a.mime
    const text = (await transcribe(new Uint8Array(dl.data), { mime, filename: dl.name || a.name || 'voice-memo' })).trim()
    return text || null
  } catch (err) {
    console.warn(`[channels] inbound voice memo ${a.guid} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Text + photo refs + one line per voice memo / unusable attachment. A failure never blocks the text. */
async function buildInput(ev: InboundMessage, client: BlueBubblesClient | null, transcribe: Transcribe): Promise<BuiltInput> {
  const lines: string[] = ev.text.trim() ? [ev.text.trim()] : []
  const attachments: AttachmentRef[] = []
  for (const a of ev.attachments) {
    if (a.mime.startsWith('image/')) {
      const ref = attachments.length < MAX_IMAGES ? await loadPhoto(client, a) : null
      if (ref) attachments.push(ref)
      else lines.push(PHOTO_FAILED)
    } else if (a.mime.startsWith('audio/')) {
      const t = await transcribeMemo(client, a, transcribe)
      lines.push(t ? `(voice memo) ${t}` : VOICE_FAILED)
    } else {
      lines.push(`(an attachment I can't open: ${a.name || 'file'})`)
    }
  }
  return { text: lines.join('\n'), attachments }
}

/**
 * Run one inbound event through the pipeline (spec §4, in order): tapback → approvals; drop
 * non-tapback reactions, Bridget's own messages, group chats and unknown senders; build the
 * input; then dedupe-insert + enqueue on main with `origin` and `replyTo` — always a new run,
 * never a steer (final review C1).
 */
export async function handleInbound(ev: InboundMessage | TapbackEvent, deps: InboundDeps = {}): Promise<InboundOutcome> {
  if (ev.kind === 'tapback') return resolveTapback(ev)
  // Ledger ruling (Task 2 carry-over): anything pointing at another message that isn't a
  // recognised tapback (iOS 18 emoji reactions, stickers) is never a turn.
  if (ev.associatedMessageGuid) return 'ignored:reaction'
  if (ev.isFromMe) return 'ignored:from-me'
  if (ev.isGroup) return 'ignored:group'

  const cfg = (await loadChannelsConfig()).imessage
  if (!isAllowed(ev.sender, cfg.allowedHandles)) {
    // Recorded so catch-up's overlap re-reading the same message doesn't warn again.
    if (await recordGuid(ev)) {
      recordEvent({ kind: 'inbound', name: 'imessage:unknown-sender', severity: 'warn', status: 'warn', meta: { sender: maskHandle(ev.sender) } })
    }
    return 'ignored:sender'
  }

  if (!ev.text.trim() && !ev.attachments.length) {
    await recordGuid(ev)
    return 'ignored:empty'
  }

  // Cheap early exit so catch-up's overlap doesn't re-download / re-transcribe a message the
  // webhook already took. The insert below is still what decides a true race.
  if (await alreadySeen(ev.guid)) return 'duplicate'

  const client = deps.client !== undefined ? deps.client : await imessageClient()
  const input = await buildInput(ev, client, deps.transcribe ?? defaultTranscribe)

  const db = useDb()
  const [won] = await db.insert(channelInbound)
    .values({ guid: ev.guid, channel: 'imessage', sender: ev.sender, receivedAt: ev.date })
    .onConflictDoNothing().returning({ guid: channelInbound.guid })
  if (!won) {
    await discardImages(input.attachments) // the other caller built (and enqueued) its own copy
    return 'duplicate'
  }

  const replyTo: ReplyTo = { channel: 'imessage', chatGuid: ev.chatGuid, messageGuid: ev.guid }
  let result
  try {
    result = await (deps.enqueueFn ?? enqueue)({
      sessionKey: deps.mainConversationId ? `thread:${deps.mainConversationId}` : 'main',
      trigger: 'user',
      profile: 'interactive',
      input: {
        text: input.text,
        modality: 'text',
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
        origin: `imessage:${ev.chatGuid}`
      },
      replyTo,
      // Final review C1 ruling: an inbound text is always its own run carrying reply_to + origin,
      // even while an interactive turn is running (it queues behind it, never steers into it).
      noSteer: true
    })
  } catch (err) {
    // Un-claim the GUID so the next catch-up retries this message rather than losing it.
    await db.delete(channelInbound).where(eq(channelInbound.guid, ev.guid))
      .catch(e => console.error(`[channels] releasing inbound ${ev.guid} failed:`, e))
    await discardImages(input.attachments)
    throw err
  }

  await db.update(channelInbound).set({ runId: result.runId }).where(eq(channelInbound.guid, ev.guid))
  return 'enqueued'
}

// ---- catch-up + health ----

interface Health { ok: boolean; privateApi: boolean | null; checkedAt: number | null; error?: string }
let health: Health = { ok: false, privateApi: null, checkedAt: null }
let lastRunAt = 0
let running = false
// The newest message date a scan fully handled. In memory only: after a restart the DB cursor
// takes over. It keeps a run of Bridget's own / group messages (which record no GUID) from
// pinning the cursor and being re-read on every tick.
let scannedUpTo = 0

export function lastHealth(): Health {
  return { ...health }
}

/** Test seam: forget the throttle, the scan high-water mark and the health snapshot. */
export function _resetCatchUp(): void {
  lastRunAt = 0
  scannedUpTo = 0
  health = { ok: false, privateApi: null, checkedAt: null }
}

async function inboundCursor(): Promise<number> {
  const [row] = await useDb().select({ at: max(channelInbound.receivedAt) }).from(channelInbound)
    .where(eq(channelInbound.channel, 'imessage'))
  return row?.at ? new Date(row.at).getTime() : Date.now() - CATCH_UP_FIRST_LOOKBACK_MS
}

async function catchUpMessages(client: BlueBubblesClient, deps: InboundDeps): Promise<number> {
  // Capped at now: a message dated in the future (clock skew on the Mac) must not push the
  // window past messages that are still to come.
  let after = Math.min(Math.max(await inboundCursor(), scannedUpTo), Date.now()) - CATCH_UP_OVERLAP_MS
  let processed = 0
  let newest = scannedUpTo
  let failedAt: number | null = null
  for (let page = 0; page < CATCH_UP_MAX_PAGES; page++) {
    const raw = await client.messagesSince(after, CATCH_UP_PAGE)
    let pageNewest = after
    for (const m of raw) {
      const date = typeof (m as { dateCreated?: unknown })?.dateCreated === 'number' ? (m as { dateCreated: number }).dateCreated : null
      if (date !== null) pageNewest = Math.max(pageNewest, date)
      const ev = parseBlueBubblesMessage(m)
      if (!ev) continue
      try {
        const outcome = await handleInbound(ev, { ...deps, client })
        if (outcome === 'enqueued') processed++
      } catch (err) {
        // One bad message never stops the rest of the scan; the overlap retries it next tick.
        console.error(`[channels] catch-up: message ${ev.guid} failed:`, err)
        if (date !== null) failedAt = failedAt === null ? date : Math.min(failedAt, date)
      }
    }
    newest = Math.max(newest, pageNewest)
    if (raw.length < CATCH_UP_PAGE || pageNewest <= after) break
    after = pageNewest
  }
  // Never move the high-water mark past a message that failed: it must stay in the next window.
  scannedUpTo = Math.min(failedAt === null ? newest : Math.min(newest, failedAt - 1), Date.now())
  return processed
}

/**
 * Confirm `sent_unconfirmed` iMessage deliveries: Bridget's own message with that text in the
 * chat since the row was first claimed → `sent`. Image-only rows can't be matched by text and
 * count as sent after 10 min (ledger ruling). Unconfirmed after a day → `failed`, no note.
 * `onlyIds` / `now` are test seams (the dev DB is shared).
 */
async function confirmUnconfirmed(client: BlueBubblesClient, opts: { onlyIds?: string[]; now?: Date }): Promise<void> {
  if (opts.onlyIds && !opts.onlyIds.length) return
  const now = (opts.now ?? new Date()).getTime()
  const where: SQL = and(eq(channelDeliveries.channel, 'imessage'), eq(channelDeliveries.status, 'sent_unconfirmed'),
    opts.onlyIds ? inArray(channelDeliveries.id, opts.onlyIds) : undefined)!
  const rows = await useDb().select().from(channelDeliveries).where(where).orderBy(asc(channelDeliveries.createdAt)).limit(CONFIRM_BATCH)
  for (const row of rows) {
    const since = (row.firstClaimedAt ?? row.createdAt).getTime()
    const age = now - since
    const text = (row.payload as { text?: string } | null)?.text ?? ''
    let set: Partial<typeof channelDeliveries.$inferInsert> | null = null
    if (age >= UNCONFIRMED_GIVE_UP_MS) {
      set = { status: 'failed', lastError: 'never confirmed by BlueBubbles' }
    } else if (!text) {
      if (age >= IMAGE_CONFIRM_AFTER_MS) set = { status: 'sent' }
    } else {
      try {
        const found = await client.findOwnMessage(row.target, text, since - OWN_MESSAGE_LOOKBACK_MS)
        if (found) set = { status: 'sent', externalId: found }
      } catch (err) {
        // 404 = the server has nothing there (not found); anything else: ask again next tick.
        if (!(err instanceof BlueBubblesError && err.status === 404)) {
          console.warn(`[channels] confirming delivery ${row.id} failed:`, err instanceof Error ? err.message : err)
        }
      }
    }
    if (!set) continue
    const updated = await useDb().update(channelDeliveries).set(set)
      .where(and(eq(channelDeliveries.id, row.id), eq(channelDeliveries.status, 'sent_unconfirmed')))
      .returning({ id: channelDeliveries.id })
    if (updated.length) publishChange({ resource: 'channelDelivery', action: 'updated', id: row.id })
  }
}

/**
 * The periodic catch-up (spec §4.6): health check, then every message since the inbound cursor
 * (minus a 5-min overlap) through handleInbound, then unconfirmed-delivery confirmation.
 * Also expires overdue approvals. Self-throttled to CATCH_UP_INTERVAL_MS; `force` bypasses it.
 * Returns null when throttled. `onlyDeliveryIds` / `onlyApprovalIds` / `now` are test seams.
 * `processed` counts messages that became a turn.
 */
export async function catchUpTick(opts: InboundDeps & { force?: boolean; onlyDeliveryIds?: string[]; onlyApprovalIds?: string[]; now?: Date } = {}): Promise<{ processed: number; healthy: boolean } | null> {
  if (running) return null
  if (!opts.force && Date.now() - lastRunAt < CATCH_UP_INTERVAL_MS) return null
  running = true
  lastRunAt = Date.now()
  try {
    // Housekeeping, whatever BlueBubbles' state: approvals whose waiter died with a restart.
    await expireApprovals(opts.now, { onlyIds: opts.onlyApprovalIds })
      .catch(err => console.error('[channels] expiring approvals failed:', err))
    const client = opts.client !== undefined ? opts.client : await imessageClient()
    if (!client) {
      health = { ok: false, privateApi: null, checkedAt: Date.now(), error: 'iMessage is not configured' }
      return { processed: 0, healthy: false }
    }
    try {
      // serverInfo also refreshes the client's cached Private-API mode (client.ts).
      const info = await client.serverInfo()
      health = { ok: true, privateApi: info.privateApi, checkedAt: Date.now() }
    } catch (err) {
      health = { ok: false, privateApi: null, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }
      return { processed: 0, healthy: false }
    }
    const { force: _f, onlyDeliveryIds, onlyApprovalIds: _a, now, ...deps } = opts
    try {
      const processed = await catchUpMessages(client, deps)
      await confirmUnconfirmed(client, { onlyIds: onlyDeliveryIds, now })
      return { processed, healthy: true }
    } catch (err) {
      health = { ...health, ok: false, error: err instanceof Error ? err.message : String(err) }
      throw err
    }
  } finally {
    running = false
  }
}
