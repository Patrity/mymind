import { loadPersona } from '@mymind/core/lib/agent/persona'

export default defineEventHandler(async () => {
  return { text: await loadPersona() }
})
