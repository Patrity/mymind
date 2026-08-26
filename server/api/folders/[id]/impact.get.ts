import { z } from 'zod'
import { folderImpact } from '../../../services/folders'
import { requireFolderId } from '../../../utils/folder-http'

const Query = z.object({ to: z.string().optional() })

export default defineEventHandler(async (event) => {
  const id = requireFolderId(event)
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  // Read-only: folderImpact reports zeros for an unknown-but-well-formed id rather than failing,
  // since the UI dialog it feeds needs a shape, not an error, while the user is still choosing a
  // destination. A malformed id can never match a real row either way, but left unvalidated it
  // would reach `eq(folders.id, id)` as a raw Postgres `invalid input syntax for type uuid` — a
  // 500 — instead of the 404 `requireFolderId` gives it above.
  return folderImpact(id, parsed.data.to)
})
