import { loadAnalyticsConfig } from '../../lib/analytics/store'

export default defineEventHandler(async () => {
  const c = await loadAnalyticsConfig()
  return {
    prometheusUrl: c.prometheusUrl,
    litellmUrl: c.litellmUrl,
    hasLitellmKey: !!c.litellmMasterKeyEnc,
    gpuLabels: c.gpuLabels,
  }
})
