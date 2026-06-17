import { loadPersona } from '../../lib/agent/persona'

export default defineEventHandler(async () => {
  return { text: await loadPersona() }
})
