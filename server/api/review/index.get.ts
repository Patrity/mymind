import { listReviewFeed } from '@mymind/core/services/review'

export default defineEventHandler(async () => {
  return listReviewFeed()
})
