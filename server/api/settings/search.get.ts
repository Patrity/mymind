import { loadSearchConfig } from '@mymind/core/lib/search/store'

export default defineEventHandler(async () => {
  const c = await loadSearchConfig()
  return { provider: c.provider, hasBraveKey: !!c.braveApiKeyEnc, braveQps: c.braveQps }
})
