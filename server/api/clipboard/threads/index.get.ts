import { listThreads } from '../../../services/clipboard'

export default defineEventHandler(async () => {
  return listThreads()
})
