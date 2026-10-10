import { countUnreviewedMemories } from '@mymind/core/services/memory'

export default defineEventHandler(async () => {
  const unreviewed = await countUnreviewedMemories()
  return { unreviewed }
})
