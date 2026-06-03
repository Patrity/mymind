import { z } from 'zod'
import { ingestTranscript } from '../../../services/sessions'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  lines: z.array(z.string().max(100_000)).max(5000)
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const body = parsed.data

  const result = await ingestTranscript({
    source: body.source,
    externalId: body.external_id,
    lines: body.lines
  })

  return result
})
