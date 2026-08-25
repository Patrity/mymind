import { deleteFolder } from '../../services/folders'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const counts = await deleteFolder(id)
  // `foldersDeleted === 0` is the service's documented "no such folder" signal — an existing
  // but empty folder still deletes its own row and reports 1, so this can't misfire on a real,
  // legitimately empty deletion.
  if (counts.foldersDeleted === 0) {
    throw createError({ statusCode: 404, statusMessage: 'Folder not found' })
  }
  publishChange({ resource: 'folder', action: 'deleted', id })
  return counts
})
