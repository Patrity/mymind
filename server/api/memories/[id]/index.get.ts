import { getMemory } from '../../../services/memory'

// Single memory (full content/tags/scope) for the Galaxy detail pane's edit
// form — the graph payload only carries a truncated label/preview, so the pane
// fetches the real row before letting you edit it (no silent truncation).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const memory = await getMemory(id)
  if (!memory) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  return memory
})
