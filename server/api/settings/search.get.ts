import { loadSearchConfig } from '../../lib/search/store'

export default defineEventHandler(async () => {
  const c = await loadSearchConfig()
  return { provider: c.provider, searxngUrl: c.searxngUrl, hasBraveKey: !!c.braveApiKeyEnc }
})
