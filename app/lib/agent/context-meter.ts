import type { AgentUIMessage } from '~~/shared/types/agent-ui'

export interface ContextMeterData {
  usedTokens: number
  maxTokens: number | null
  modelDefId: string | null
}

/**
 * Extract context meter data from the message list and available models.
 * Returns the latest assistant message's context usage and its model's window,
 * or null if no message has reported contextTokens yet.
 *
 * The modelDefId is sourced from the message's usage metadata if available,
 * otherwise falls back to the first non-null value in fallbackModelIds (the
 * selected/chain-head models).
 */
export function contextMeterData(
  messages: AgentUIMessage[],
  models: { id: string; contextWindow: number | null }[],
  fallbackModelIds: (string | null | undefined)[]
): ContextMeterData | null {
  // Walk messages from the end (latest first) to find the first assistant message
  // that reported contextTokens
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'assistant') continue

    const usage = msg.metadata?.usage
    if (!usage || typeof usage.contextTokens !== 'number') continue

    const usedTokens = usage.contextTokens

    // Determine the modelDefId: use what's in the usage, or fall back to the
    // first non-null value in fallbackModelIds
    let modelDefId = usage.modelDefId ?? null
    if (!modelDefId) {
      for (const fallback of fallbackModelIds) {
        if (fallback) {
          modelDefId = fallback
          break
        }
      }
    }

    // Look up the model's context window
    const model = models.find(m => m.id === modelDefId)
    const maxTokens = model?.contextWindow ?? null

    return { usedTokens, maxTokens, modelDefId }
  }

  return null
}
