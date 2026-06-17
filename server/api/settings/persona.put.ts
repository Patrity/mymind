import { savePersona } from '../../lib/agent/persona'

export default defineEventHandler(async (event) => {
  const { text } = await readBody<{ text?: string }>(event)
  if (typeof text !== 'string' || !text.trim()) {
    throw createError({ statusCode: 400, message: 'persona text required' })
  }
  await savePersona(text.trim())
  return { text: text.trim() }
})
