import { loadObsConfig, redactObsConfig } from '@mymind/core/lib/observability/config'

export default defineEventHandler(async () => {
  return redactObsConfig(await loadObsConfig())
})
