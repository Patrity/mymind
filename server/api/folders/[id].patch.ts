import { z } from 'zod'
import { moveFolder, setFolderColor } from '../../services/folders'
import { FOLDER_PALETTE } from '../../../shared/types/folders'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  path: z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash').optional(),
  // Present + null clears the colour override back to inheriting; key omitted entirely means
  // "leave colour untouched" — the two are distinguished by `undefined` vs `null` below, not
  // collapsed into one falsy check.
  color: z.union([z.enum(FOLDER_PALETTE), z.null()]).optional()
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
    if (!result.ok) {
      // not-found (bad id) -> 404, invalid (root / move-into-self) -> 400, collision -> 409.
      // Mapped off the typed `reason` discriminant, never string-matched against `conflict`.
      const statusCode = result.reason === 'not-found' ? 404 : result.reason === 'invalid' ? 400 : 409
      // For a collision, `conflict` is the bare colliding PATH — the thing the user renames —
      // so it gets a short explanatory prefix here. The other two reasons already carry a
      // human-readable message and are passed through unchanged.
      const statusMessage = result.reason === 'collision' ? `Path already taken: ${result.conflict}` : result.conflict
      throw createError({ statusCode, statusMessage })
    }
  }

  if (body.color !== undefined) {
    const updated = await setFolderColor(id, body.color)
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }

  publishChange({ resource: 'folder', action: 'updated', id })
  return { ok: true }
})
