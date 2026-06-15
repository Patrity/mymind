import { loadObsConfig, redactObsConfig } from '../../lib/observability/config'

export default defineEventHandler(async () => {
  return redactObsConfig(await loadObsConfig())
})
