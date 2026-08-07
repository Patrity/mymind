// app/lib/agent/transcript.ts
//
// Rebuilding a resumed conversation's transcript entries from persisted messages. Extracted
// out of app/pages/agent/index.vue so it is unit-testable: both of the Important findings
// against the original resume() lived in this logic, and an SFC method gave the gates zero
// signal (the review's deferred "no unit test for resume()'s slicing" item).
import type { TranscriptEntry } from '~/composables/useVoice'
import type { ConversationMessageDTO } from '~~/shared/types/conversation'

/** Only the fields the transcript rebuild reads — keeps this callable from a test fixture. */
export type ResumeMessage = Pick<ConversationMessageDTO, 'id' | 'role' | 'content'>
  & Partial<Pick<ConversationMessageDTO, 'toolCalls' | 'reasoning' | 'attachments'>>

/**
 * Persisted messages → transcript entries, with tool chips at their true inline position.
 *
 * Each record's `textOffset` is an index into the message's PERSISTED content (the server
 * records it against the sanitized text — see server/lib/agent/image-embed.ts
 * `sanitizedOffset`), so slicing at it reproduces the order the live stream rendered in.
 */
export function buildResumeTranscript(messages: ResumeMessage[]): TranscriptEntry[] {
  return messages.flatMap<TranscriptEntry>((m) => {
    const records = (m.role === 'assistant' && m.toolCalls?.length) ? m.toolCalls : []
    // Legacy rows have no textOffset — fall back to the old "chips first" render.
    // All-or-nothing: only take the structured-split branch when EVERY record carries
    // an offset. A message mixing offset and offset-less records must not silently
    // drop the offset-less ones by filtering them out of the loop.
    const allOffset = records.length > 0 && records.every(t => typeof t.textOffset === 'number')
    if (!allOffset) {
      return [
        ...records.map((t, i) => ({ id: `${m.id}-tool-${i}`, role: 'tool' as const, text: '', name: t.name, summary: t.summary, undoToken: t.undoToken })),
        { id: m.id, role: m.role, text: m.content, attachments: m.attachments ?? undefined, reasoning: m.reasoning ?? undefined }
      ]
    }

    const entries: TranscriptEntry[] = []
    let cursor = 0
    records.forEach((t, i) => {
      const at = Math.min(Math.max(t.textOffset!, 0), m.content.length)
      if (at > cursor) entries.push({ id: `${m.id}-txt-${i}`, role: m.role, text: m.content.slice(cursor, at) })
      entries.push({ id: `${m.id}-tool-${i}`, role: 'tool', text: '', name: t.name, summary: t.summary, undoToken: t.undoToken })
      // Never walk backwards: sanitizedOffset is NOT monotonic (it strips image markdown, so
      // a marker completing between two calls shrinks the later offset). An unguarded cursor
      // would make the trailing slice re-emit text an earlier bubble already rendered.
      cursor = Math.max(cursor, at)
    })
    // A chip at the very end of the reply (no trailing commentary) must not leave a
    // floating empty "Bridget" bubble — Transcript.vue renders the role label
    // regardless of text. Only skip the trailing entry when it would carry nothing at
    // all; reasoning/attachments still need to ride on it even with empty text.
    const trailingText = m.content.slice(cursor)
    if (trailingText || m.reasoning || m.attachments?.length) {
      entries.push({ id: m.id, role: m.role, text: trailingText, attachments: m.attachments ?? undefined, reasoning: m.reasoning ?? undefined })
    }
    return entries
  })
}
