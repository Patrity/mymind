import { z } from 'zod'
import { mergeProjects } from '../../../services/project-merge'
import { dedupMemoriesAfterMerge } from '../../../services/memory'
import { publishChange } from '../../../utils/live-bus'

const Body = z.object({ targetSlug: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const loserSlug = getRouterParam(event, 'slug')!
  const { targetSlug } = Body.parse(await readBody(event))
  try {
    const { winner, repointedMemoryIds } = await mergeProjects(loserSlug, targetSlug)
    await dedupMemoriesAfterMerge(repointedMemoryIds)
    // emit: loser deleted + winner updated + all child lists refresh
    publishChange({ resource: 'project', action: 'deleted', id: loserSlug })
    publishChange({ resource: 'project', action: 'updated', id: winner.slug })
    for (const r of ['session', 'task', 'memory', 'document'] as const) publishChange({ resource: r, action: 'updated', id: winner.slug })
    return winner
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('MERGE_NOT_FOUND')) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    if (msg.includes('MERGE_SELF')) throw createError({ statusCode: 400, statusMessage: 'Cannot merge a project into itself' })
    if (msg.includes('MERGE_UNCATEGORIZED')) throw createError({ statusCode: 400, statusMessage: 'Cannot merge into/from Uncategorized' })
    throw err
  }
})
