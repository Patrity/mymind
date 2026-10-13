// server/lib/search/resolve.ts
// Resolves the active SearchProvider from the persisted config.
import { loadSearchConfig } from './store'
import { searxngProvider } from './providers/searxng'
import { braveProvider } from './providers/brave'
import { decryptSecret } from '../ai/registry/crypto'
import type { SearchProvider } from './types'
import { currentEvalScope } from '../eval/context'

export async function searchProvider(): Promise<SearchProvider> {
  // Cycle 85: an eval world answers searches from its recorded results (no SearXNG / Brave).
  const scope = currentEvalScope()
  if (scope) return { search: (q, opts) => scope.webSearch(q, opts) }
  const c = await loadSearchConfig()
  if (c.provider === 'brave') return braveProvider(c.braveApiKeyEnc ? decryptSecret(c.braveApiKeyEnc) : '')
  return searxngProvider(c.searxngUrl)
}
