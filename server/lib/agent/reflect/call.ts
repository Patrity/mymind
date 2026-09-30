// server/lib/agent/reflect/call.ts
//
// The single model call per reflector pass. Never throws: a model failure (chat() throws on an
// empty reply, and after the failover chain is exhausted) comes back as ok:false so the caller
// can mark the thread for a retry on the next tick.
import { chat, type ChatMessage } from '../../ai/chat'
import { parseReflectorOutput, type Proposal, type ReflectorResult } from './schema'

export async function callReflector(
  messages: ChatMessage[],
  allowed: Proposal['kind'][],
  deps: { chatFn?: typeof chat } = {}
): Promise<ReflectorResult> {
  let raw: string
  try {
    raw = await (deps.chatFn ?? chat)('reasoning', messages, { temperature: 0.2, maxTokens: 1500 })
  } catch (err) {
    return { ok: false, error: `reflector call failed: ${(err as Error)?.message ?? String(err)}` }
  }
  return parseReflectorOutput(raw, allowed)
}
