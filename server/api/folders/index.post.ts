import { z } from 'zod'
import { createFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'
import { folderOpError } from '../../utils/folder-http'

const Body = z.object({
  path: z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash')
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }

  const result = await createFolder(parsed.data.path)
  // Only 'invalid' (bare root path) is reachable here in practice — the regex above already
  // rejects it — but folderOpError maps all three reasons, so this stays correct if the
  // service ever grows another failure mode for create.
  if (!result.ok) throw folderOpError(result)

  publishChange({ resource: 'folder', action: 'created', id: result.folder.id })
  return result.folder
})
