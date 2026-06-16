import { searchAll } from '../services/search'
import type { SearchResults } from '../../shared/types/search'

const emptyResults: SearchResults = {
  documents: [],
  memories: [],
  images: [],
  tasks: [],
  projects: [],
  sessions: [],
  messages: []
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  if (typeof q !== 'string' || !q.trim() || q.length > 200) return emptyResults
  return searchAll(q.trim())
})
