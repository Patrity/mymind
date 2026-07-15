import { z } from 'zod'
import { reassignSession } from '../../services/sessions'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({ project: z.string().min(1), pathPrefix: z.string().nullish() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  let res
  try {
    res = await reassignSession(id, { projectSlug: body.project, pathPrefix: body.pathPrefix ?? null })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: msg.includes('not found') ? 404 : 400, statusMessage: msg })
  }
  publishChange({ resource: 'session', action: 'updated', id })
  if (res.from) publishChange({ resource: 'project', action: 'updated', id: res.from })
  publishChange({ resource: 'project', action: 'updated', id: res.to })
  publishChange({ resource: 'memory', action: 'updated', id })
  return { ok: true, ...res }
})
