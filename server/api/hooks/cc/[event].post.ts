import { z } from 'zod'
import { upsertSession } from '../../../services/sessions'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  project: z.string().nullish(),
  cwd: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export default defineEventHandler(async (event) => {
  const eventName = getRouterParam(event, 'event') ?? 'unknown'
  const body = Body.parse(await readBody(event))

  const metadata: Record<string, unknown> = {
    ...(body.metadata ?? {}),
    lastEvent: eventName
  }

  const session = await upsertSession({
    source: body.source,
    externalId: body.external_id,
    project: body.project ?? undefined,
    cwd: body.cwd ?? undefined,
    metadata
  })

  return { ok: true, sessionId: session.id }
})
