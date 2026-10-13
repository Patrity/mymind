import { loadSearchConfig, saveSearchConfig, validQps, MAX_BRAVE_QPS } from '@mymind/core/lib/search/store'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ braveApiKey?: string; braveQps?: number }>(event)

  if (body.braveQps !== undefined && !validQps(body.braveQps)) {
    throw createError({ statusCode: 400, message: `braveQps must be a number greater than 0 and at most ${MAX_BRAVE_QPS}` })
  }

  await saveSearchConfig({
    braveApiKey: body.braveApiKey?.trim() || undefined,
    braveQps: body.braveQps,
  })
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('search')

  const c = await loadSearchConfig()
  return { provider: c.provider, hasBraveKey: !!c.braveApiKeyEnc, braveQps: c.braveQps }
})
