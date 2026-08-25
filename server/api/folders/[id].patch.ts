import { z } from 'zod'
import { moveFolder, setFolderColor } from '../../services/folders'
import { FOLDER_PALETTE } from '../../../shared/types/folders'
import { publishChange } from '../../utils/live-bus'
import { folderOpError } from '../../utils/folder-http'

const Body = z.object({
  path: z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash').optional(),
  // Present + null clears the colour override back to inheriting; key omitted entirely means
  // "leave colour untouched" — the two are distinguished by `undefined` vs `null` below, not
  // collapsed into one falsy check.
  color: z.union([z.enum(FOLDER_PALETTE), z.null()]).optional()
}).refine(b => b.path !== undefined || b.color !== undefined, {
  // Without this, `{}` is schema-valid, neither branch below runs, nothing is checked or
  // touched, and execution used to fall through to an unconditional publishChange — a 200
  // that changed nothing and fired a live event for ANY id, garbage included. Reject it
  // before either service call, rather than trying to detect "nothing happened" after.
  message: 'must include at least one of path or color'
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const body = parsed.data

  if (body.path !== undefined) {
    const result = await moveFolder(id, body.path)
    if (!result.ok) throw folderOpError(result)
  }

  if (body.color !== undefined) {
    const updated = await setFolderColor(id, body.color)
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }

  publishChange({ resource: 'folder', action: 'updated', id })
  return { ok: true }
})
