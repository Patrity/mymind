import { archiveMemory, unarchiveMemory } from '@mymind/core/services/memory'
import { publishChange } from '@mymind/core/utils/live-bus'
import { registerUndo } from '@mymind/core/lib/agent/undo'

// Archiving is the memory "delete" (getGraph filters on archivedAt, so the node
// disappears live). We register an undo entry so the detail pane can offer
// "Undo" — it un-archives the same row and re-emits the live event.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await archiveMemory(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  publishChange({ resource: 'memory', action: 'updated', id })
  const undoToken = registerUndo(async () => {
    await unarchiveMemory(id)
    publishChange({ resource: 'memory', action: 'updated', id })
  })
  return { ok: true, undoToken }
})
