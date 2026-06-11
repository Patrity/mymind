import { loadConfig } from '../../lib/ai/registry/store'
import { redactDoc } from '../../lib/ai/registry/schema'

export default defineEventHandler(async () => {
  return redactDoc(await loadConfig())
})
