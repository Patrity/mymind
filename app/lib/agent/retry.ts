// app/lib/agent/retry.ts
//
// Pure "walk back to the preceding user turn and truncate" logic behind retryTurn.
// Extracted out of app/pages/agent/index.vue for the same reason buildResumeTranscript
// was (see transcript.ts): an SFC method gives the test gates zero signal.
import type { TranscriptEntry } from '~/composables/useVoice'

export interface RetryPlan {
  /** The transcript with the target assistant turn AND everything from the preceding
   *  user turn onward removed — voice.sendText() re-creates the user bubble fresh. */
  transcript: TranscriptEntry[]
  /** The user turn to re-send. */
  userTurn: TranscriptEntry
}

/**
 * Given the full transcript and the id of an assistant entry to retry, walk
 * backwards from it (skipping any interleaved tool chips) to find the user turn
 * that produced it, then truncate the transcript to just before that user turn.
 *
 * This REPLACES in place — it does not fork. If `entryId` sits earlier than the
 * last turn, everything after the preceding user turn is dropped too (including
 * whatever came after the retried entry), matching "retry regenerates the reply
 * from here forward," not "insert a branch."
 *
 * Returns null when `entryId` isn't found, or when no user turn precedes it
 * (nothing to re-send).
 */
export function truncateForRetry(transcript: TranscriptEntry[], entryId: string): RetryPlan | null {
  const i = transcript.findIndex(e => e.id === entryId)
  if (i < 0) return null

  let j = i - 1
  while (j >= 0 && transcript[j]!.role !== 'user') j--
  const userTurn = j >= 0 ? transcript[j] : undefined
  if (!userTurn) return null

  return { transcript: transcript.slice(0, j), userTurn }
}
