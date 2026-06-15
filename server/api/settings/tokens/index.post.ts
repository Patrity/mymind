import { z } from 'zod'
import { requireSession } from '../../../utils/auth-guard'
import { createToken } from '../../../services/api-tokens'

const Body = z.object({ name: z.string().min(1).max(100) })

export default defineEventHandler(async (event) => {
  requireSession(event)
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  return createToken(parsed.data.name)
})
