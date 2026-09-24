import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations } from '../db/schema'
import { publishChange } from '../utils/live-bus'

/**
 * `/clear` — make Bridget forget the transcript without deleting it.
 *
 * Rows are NOT deleted: cycle 68 established that a conversation is a tree and nothing is ever
 * removed (retry branches rather than truncates). An epoch keeps the transcript searchable via
 * cycle-13 session/message search and makes an accidental clear recoverable.
 *
 * The summary reset is not optional. The summary is DERIVED from the transcript, so wiping the
 * turns while leaving it means Bridget still remembers everything just cleared, compressed. A
 * /clear that does not reset the summary is a lie.
 *
 * Memories already graduated out of this conversation are untouched — that is the forgetting
 * ladder working as designed, not a leak.
 */
export async function clearConversationContext(conversationId: string): Promise<void> {
  await useDb().update(conversations)
    .set({ contextEpochAt: new Date(), summary: null, summaryEmbedding: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  publishChange({ resource: 'conversation', action: 'updated', id: conversationId })
}
