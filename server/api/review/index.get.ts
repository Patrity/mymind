import { listReviewFeed } from '../../services/review'

export default defineEventHandler(async () => {
  return listReviewFeed()
})
