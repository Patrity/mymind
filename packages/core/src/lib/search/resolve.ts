// server/lib/search/resolve.ts
// Resolves the SearchProvider: Brave is the only backend (cycle 86).
import { loadSearchConfig } from './store'
import { braveProvider } from './providers/brave'
import { braveLimiter } from './limiter'
import { decryptSecret } from '../ai/registry/crypto'
import type { SearchProvider } from './types'
import { currentEvalScope } from '../eval/context'

export async function searchProvider(): Promise<SearchProvider> {
  // Cycle 85: an eval world answers searches from its recorded results (no Brave call).
  const scope = currentEvalScope()
  if (scope) return { search: (q, opts) => scope.webSearch(q, opts) }
  const c = await loadSearchConfig()
  braveLimiter.setRate(c.braveQps)
  return braveProvider(c.braveApiKeyEnc ? decryptSecret(c.braveApiKeyEnc) : '')
}
