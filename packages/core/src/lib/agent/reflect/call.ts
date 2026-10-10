// server/lib/agent/reflect/call.ts
//
// The single model call per reflector pass. Never throws: a model failure (chat() throws on an
// empty reply, and after the failover chain is exhausted) comes back as ok:false so the caller
// can mark the thread for a retry on the next tick.
import { chat, type ChatMessage } from '../../ai/chat'
import { parseReflectorOutput, type Proposal, type ReflectorResult } from './schema'

/** Output budget. A profile.edit carries the FULL profile (up to 1,500 tokens) and a skill.create
 *  a full file (up to 4 KB ≈ 1k tokens), plus JSON escaping, reason and evidence — and up to 3 of
 *  them. At 1,500 a single large proposal was cut mid-string and lost after two paid calls
 *  (final review I1). */
export const REFLECT_MAX_TOKENS = 6000
/** Per-attempt timeout: a 6k-token reply on the reasoning chain can take well over the default minute. */
export const REFLECT_TIMEOUT_MS = 120_000

export async function callReflector(
  messages: ChatMessage[],
  allowed: Proposal['kind'][],
  deps: { chatFn?: typeof chat } = {}
): Promise<ReflectorResult> {
  let raw: string
  try {
    raw = await (deps.chatFn ?? chat)('reasoning', messages, { temperature: 0.2, maxTokens: REFLECT_MAX_TOKENS, timeoutMs: REFLECT_TIMEOUT_MS })
  } catch (err) {
    return { ok: false, error: `reflector call failed: ${(err as Error)?.message ?? String(err)}` }
  }
  return parseReflectorOutput(raw, allowed)
}
