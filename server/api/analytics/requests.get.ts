import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { fetchSpendLogs } from '../../lib/analytics/litellm'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(String(q.pageSize ?? '25'), 10) || 25))
  const cfg = await loadAnalyticsConfig()
  try {
    return await fetchSpendLogs(cfg, page, pageSize)
  } catch (err) {
    const e = err as { statusCode?: number, statusMessage?: string, message?: string }
    if (e.statusCode === 409) throw err
    throw createError({ statusCode: 502, statusMessage: `LiteLLM unreachable: ${e.statusMessage ?? e.message}` })
  }
})
