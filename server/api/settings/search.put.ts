import { loadSearchConfig, saveSearchConfig } from '../../lib/search/store'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ provider?: string; searxngUrl?: string; braveApiKey?: string }>(event)

  if (body.provider !== 'searxng' && body.provider !== 'brave') {
    throw createError({ statusCode: 400, message: 'provider must be searxng or brave' })
  }
  if (typeof body.searxngUrl !== 'string' || !body.searxngUrl.trim()) {
    throw createError({ statusCode: 400, message: 'searxngUrl required' })
  }

  await saveSearchConfig({
    provider: body.provider,
    searxngUrl: body.searxngUrl.trim(),
    braveApiKey: body.braveApiKey?.trim() || undefined,
  })

  const c = await loadSearchConfig()
  return { provider: c.provider, searxngUrl: c.searxngUrl, hasBraveKey: !!c.braveApiKeyEnc }
})
