import { searchDocs } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  if (typeof q !== 'string' || !q.trim()) return []
  return searchDocs(q.trim())
})
