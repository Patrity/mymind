import { z } from 'zod'
import { reassignSessions } from '../../services/sessions'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  project: z.string().min(1),
  pathPrefix: z.string().nullish()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  let res
  try {
    res = await reassignSessions(body.ids, { projectSlug: body.project, pathPrefix: body.pathPrefix ?? null })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: msg.includes('not found') ? 404 : 400, statusMessage: msg })
  }
  for (const id of body.ids) {
    publishChange({ resource: 'session', action: 'updated', id })
    publishChange({ resource: 'memory', action: 'updated', id })
  }
  for (const slug of new Set([...res.froms.filter((s): s is string => !!s), res.to])) {
    publishChange({ resource: 'project', action: 'updated', id: slug })
  }
  return { ok: true, count: body.ids.length, ...res }
})
