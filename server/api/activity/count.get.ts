import { countErrors } from '../../services/activity'

export default defineEventHandler(async () => {
  return countErrors()
})
