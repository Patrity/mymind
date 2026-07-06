import { loadAnalyticsConfig, parseAnalyticsConfigInput, saveAnalyticsConfig } from '../../lib/analytics/store'

export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseAnalyticsConfigInput(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message })
  }

  // Save-time validation: the new Prometheus URL must answer buildinfo.
  const current = await loadAnalyticsConfig()
  if (input.prometheusUrl && input.prometheusUrl !== current.prometheusUrl) {
    try {
      await $fetch(`${input.prometheusUrl}/api/v1/status/buildinfo`, { timeout: 3000 })
    } catch {
      throw createError({ statusCode: 422, statusMessage: `Prometheus did not answer at ${input.prometheusUrl}` })
    }
  }

  const saved = await saveAnalyticsConfig(input)
  return {
    prometheusUrl: saved.prometheusUrl,
    litellmUrl: saved.litellmUrl,
    hasLitellmKey: !!saved.litellmMasterKeyEnc,
    gpuLabels: saved.gpuLabels,
  }
})
