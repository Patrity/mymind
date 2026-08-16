import { countReviewPending } from '../../services/review'

export default defineEventHandler(async () => {
  const pending = await countReviewPending()
  return { pending }
})
