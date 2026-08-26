import { z } from 'zod'
import { moveFolder, setFolderColor } from '../../services/folders'
import { FOLDER_PALETTE } from '../../../shared/types/folders'
import { publishChange } from '../../utils/live-bus'
import { folderOpError, requireFolderId, FOLDER_PATH_SCHEMA } from '../../utils/folder-http'

const Body = z.object({
  path: FOLDER_PATH_SCHEMA.optional(),
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
  const id = requireFolderId(event)
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
    // Same 404 shape as `folderOpError`'s 'not-found' branch (`moveFolder`'s failure path just
    // above) — one route must not describe the same "no such folder" outcome two different ways
    // depending on which field happened to be in the body.
    if (!updated) throw createError({ statusCode: 404, statusMessage: `no folder with id ${id}` })
  }

  publishChange({ resource: 'folder', action: 'updated', id })
  return { ok: true }
})
