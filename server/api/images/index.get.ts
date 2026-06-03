import { listImages } from '../../services/images'

export default defineEventHandler(async () => {
  return listImages()
})
