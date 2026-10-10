import { countReviewPending } from '@mymind/core/services/review'

export default defineEventHandler(async () => {
  const pending = await countReviewPending()
  return { pending }
})
