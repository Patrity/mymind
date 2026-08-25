import { z } from 'zod'
import { createFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  path: z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash')
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }

  const result = await createFolder(parsed.data.path)
  if (!result.ok) {
    // Only 'invalid' (bare root path) is reachable here in practice — the regex above already
    // rejects it — but the mapping is written off the typed `reason`, not string-matched, so it
    // stays correct if the service ever grows another failure mode for create.
    const statusCode = result.reason === 'not-found' ? 404 : result.reason === 'invalid' ? 400 : 409
    throw createError({ statusCode, statusMessage: result.conflict })
  }

  publishChange({ resource: 'folder', action: 'created', id: result.folder.id })
  return result.folder
})
