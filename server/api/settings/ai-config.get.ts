import { loadConfig } from '@mymind/core/lib/ai/registry/store'
import { redactDoc } from '@mymind/core/lib/ai/registry/schema'

export default defineEventHandler(async () => {
  return redactDoc(await loadConfig())
})
