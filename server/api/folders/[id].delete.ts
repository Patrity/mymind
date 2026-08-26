import { deleteFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'
import { requireFolderId } from '../../utils/folder-http'

export default defineEventHandler(async (event) => {
  const id = requireFolderId(event)
  const counts = await deleteFolder(id)
  // `foldersDeleted === 0` is the service's documented "no such folder" signal — an existing
  // but empty folder still deletes its own row and reports 1, so this can't misfire on a real,
  // legitimately empty deletion. Same message shape as the service layer's own not-found errors
  // (see folders.ts's `notFound()`) — one API surface, one way to say "no such folder".
  if (counts.foldersDeleted === 0) {
    throw createError({ statusCode: 404, statusMessage: `no folder with id ${id}` })
  }
  publishChange({ resource: 'folder', action: 'deleted', id })
  return counts
})
