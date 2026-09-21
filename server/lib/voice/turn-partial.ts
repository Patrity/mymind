// server/lib/voice/turn-partial.ts
//
// Rescues the messages of a turn that did NOT complete.
//
// The success path derives its messages from `s.history`, which the agent call only
// reassigns when it RETURNS. So a turn that aborted, threw, or hung produced an empty
// `added` array and persisted nothing at all — including the user's own message. The user
// saw their question on screen, because the client holds it in memory, while the database
// never received it; a reload lost it silently.
//
// The turn's text is still recoverable: both halves are emitted as `transcript` events as
// they are produced (voice turns emit the user half post-STT, typed turns emit it directly),
// so ws.ts captures them and hands them here when the turn fails.

import type { AgentMessage } from '../agent/run'

/**
 * Build the messages worth saving for an unfinished turn.
 *
 * The user's text is stored verbatim — it is what they actually typed or said, and a turn
 * failing is not a reason to edit it. Assistant text is only included when it carries
 * something; a turn that died before producing output should not leave an empty bubble.
 */
export function partialTurnMessages(userText: string, assistantText: string): AgentMessage[] {
  // No user text means there is no turn here to rescue — a stray assistant fragment with
  // nothing that prompted it would be unattributable noise in the thread.
  if (!userText.trim()) return []
  const out: AgentMessage[] = [{ role: 'user', content: userText }]
  if (assistantText.trim()) out.push({ role: 'assistant', content: assistantText })
  return out
}
