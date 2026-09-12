import { ingestTranscript } from '../../../services/sessions'
import { TranscriptBody } from '../../../lib/transcript/ingest-limits'

export default defineEventHandler(async (event) => {
  const parsed = TranscriptBody.safeParse(await readBody(event))
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
