import { listImages } from '../../services/images'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q : undefined
  const tagsRaw = typeof query.tags === 'string' ? query.tags : undefined
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined
  return listImages({ q, tags })
})
