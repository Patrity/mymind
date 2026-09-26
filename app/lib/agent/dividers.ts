// Where to draw the "Bridget's memory starts here" divider for a `/clear` boundary.
//
// Pure, and in its own module, because the interesting part is entirely positional and the
// alternative is asserting it through a composable that owns a WebSocket. Cycle 71 shipped a
// divider that existed only in the tab that ran `/clear`; deriving it from the persisted
// epoch is what makes it survive a reload, and this is the half worth pinning with tests.

/** The minimum a message needs for the divider to be placed against it. */
export interface DividerMessage {
  id: string
  /** Absent while a message is still streaming — it has no persisted row yet. */
  metadata?: { createdAt?: string }
}

export interface Divider {
  /** Draw after this message; `null` means draw above the whole transcript. */
  afterMessageId: string | null
  epochAt: string
}

/**
 * Place the divider after the last message that predates `epochAt`.
 *
 * `messages` must be in chronological order — the walk stops at the first message at or after
 * the epoch, which is what keeps a later clear from being dragged backwards by an out-of-order
 * row. A message with no `createdAt` is treated as infinitely recent: anything still streaming
 * necessarily began after a clear that has already committed, so it belongs below the line.
 *
 * Returns an empty array when the thread has never been cleared, or when `epochAt` is
 * unparseable — a bad timestamp should render no divider rather than one at a wrong place.
 * One epoch per conversation, because `conversations.context_epoch_at` is a single column:
 * clearing twice moves the boundary rather than adding a second one.
 */
export function epochDividers(
  epochAt: string | null | undefined,
  messages: readonly DividerMessage[]
): Divider[] {
  if (!epochAt) return []
  const epoch = Date.parse(epochAt)
  if (Number.isNaN(epoch)) return []

  let afterMessageId: string | null = null
  for (const m of messages) {
    const raw = m.metadata?.createdAt
    const created = raw ? Date.parse(raw) : Number.POSITIVE_INFINITY
    // `!(created < epoch)` rather than `created >= epoch` so a NaN createdAt (a malformed
    // stored timestamp) stops the walk instead of silently comparing false and sliding the
    // divider past every later message.
    if (!(created < epoch)) break
    afterMessageId = m.id
  }
  return [{ afterMessageId, epochAt }]
}
