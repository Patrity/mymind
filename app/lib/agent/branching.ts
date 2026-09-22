// The client's half of the conversation tree, as pure functions.
//
// Every TREE decision is the server's — the client only ever fetches the active path, so it
// cannot resolve a branch parent or a branch tip. What is left on the client is small but
// load-bearing: which sibling the pager switches to, which question a regenerate re-sends, and
// which id is safe to put the leaf back to. All three used to live inline in
// app/pages/agent/index.vue, where nothing could test them — a whole-branch review broke the
// sibling pick by one index and typecheck, 1933 unit tests and 246 DB tests all stayed green.
// They live here so a break reddens something.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

/**
 * The sibling the ‹ n/N › pager should switch to.
 *
 * `siblingIds` is every branch of a message (its parent's children) in creation order INCLUDING
 * the one on screen, and `branch.index` is 1-BASED — the server guarantees
 * `siblingIds[index - 1] === id` (shared/types/conversation.ts). So the neighbour in direction
 * `dir` is at `index - 1 + dir`, and the two ends return undefined rather than wrapping: the
 * pager disables its arrows there (BranchPager.vue), and a wrap would make ‹ from 1/3 jump to
 * the far branch instead of doing nothing.
 *
 * Returns undefined when there is nothing to switch to — the caller must not move the leaf.
 */
export function siblingTarget(
  siblingIds: readonly string[] | undefined,
  index: number | undefined,
  dir: -1 | 1
): string | undefined {
  const ids = siblingIds ?? []
  // A message the server never annotated reads as a lone trunk message (index 1, no siblings),
  // the same default msgToDTO applies — so it has no neighbour either way.
  const at = (index ?? 1) - 1 + dir
  if (at < 0 || at >= ids.length) return undefined
  return ids[at]
}

/**
 * The user message a reply hangs off, walking BACK along the active path.
 *
 * Regenerate re-sends this question as an edit of it (see retryTurn), so getting it wrong
 * re-sends the wrong turn. Returns null when the message is not on the path, or when nothing
 * above it is a user message — a rescued turn always writes the user row first, so that is
 * narrow, but the caller must say so rather than doing nothing in silence.
 */
export function precedingUserMessage(
  messages: readonly AgentUIMessage[],
  messageId: string
): AgentUIMessage | null {
  const i = messages.findIndex(m => m.id === messageId)
  if (i < 0) return null
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j]
    if (m?.role === 'user') return m
  }
  return null
}

/**
 * The id the leaf can be PUT BACK to if a branch move's turn never goes out — or undefined if
 * the client cannot name it.
 *
 * The active path ends AT the leaf, so the last message on screen IS the leaf — but only when
 * that message is a persisted ROW. A message that is still the live stream's carries a
 * `randomUUID` minted for the stream, not a row id (lib/agent/turn-stream.ts), and the page
 * skips its post-turn re-read whenever the tail carries a client-only marker (stopped,
 * connection lost). PATCHing a stream id 404s; worse, falling back to the last id we DO
 * recognise would point the leaf at the turn BEFORE the real one and truncate the thread —
 * the exact failure restoring exists to prevent.
 *
 * A persisted row is recognised by the server-supplied `siblingIds`, which msgToDTO always
 * populates and always includes the row's own id in (`?? [r.id]`), and which a streamed
 * message never has.
 */
export function restorableLeafId(messages: readonly AgentUIMessage[]): string | undefined {
  const tail = messages.at(-1)
  if (!tail) return undefined
  return tail.metadata?.siblingIds?.includes(tail.id) ? tail.id : undefined
}
