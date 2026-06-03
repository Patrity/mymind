import { z } from 'zod'
import { ingestTranscript } from '../../../services/sessions'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  lines: z.array(z.string())
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))

  const result = await ingestTranscript({
    source: body.source,
    externalId: body.external_id,
    lines: body.lines
  })

  return result
})
