import { countUnreviewedMemories } from '../../services/memory'

export default defineEventHandler(async () => {
  const unreviewed = await countUnreviewedMemories()
  return { unreviewed }
})
