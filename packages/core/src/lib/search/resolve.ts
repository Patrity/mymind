// server/lib/search/resolve.ts
// Resolves the active SearchProvider from the persisted config.
import { loadSearchConfig } from './store'
import { searxngProvider } from './providers/searxng'
import { braveProvider } from './providers/brave'
import { decryptSecret } from '../ai/registry/crypto'
import type { SearchProvider } from './types'

export async function searchProvider(): Promise<SearchProvider> {
  const c = await loadSearchConfig()
  if (c.provider === 'brave') return braveProvider(c.braveApiKeyEnc ? decryptSecret(c.braveApiKeyEnc) : '')
  return searxngProvider(c.searxngUrl)
}
