// server/lib/agent/runtime/summarize-hook.ts
// queue.ts calls this after every persisted/rescued turn.
import { maybeSummarize } from './summarize'

/** Fire-and-forget after a run persists. Never throws, never delays the next run. */
export function maybeSummarizeLater(conversationId: string): void {
  setImmediate(() => { maybeSummarize(conversationId).catch(err => console.warn('[summarize] after-run fold failed:', err)) })
}
