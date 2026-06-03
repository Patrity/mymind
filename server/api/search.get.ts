import { searchAll } from '../services/search'
import type { SearchResults } from '../../shared/types/search'

const emptyResults: SearchResults = {
  documents: [],
  memories: [],
  images: [],
  tasks: [],
  projects: []
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  if (typeof q !== 'string' || !q.trim()) return emptyResults
  return searchAll(q.trim())
})
