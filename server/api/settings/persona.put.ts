import { savePersona } from '@mymind/core/lib/agent/persona'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

export default defineEventHandler(async (event) => {
  const { text } = await readBody<{ text?: string }>(event)
  if (typeof text !== 'string' || !text.trim()) {
    throw createError({ statusCode: 400, message: 'persona text required' })
  }
  await savePersona(text.trim())
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('persona')
  return { text: text.trim() }
})
