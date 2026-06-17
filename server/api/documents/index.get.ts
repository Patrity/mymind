import { listDocs } from '../../services/documents'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return listDocs({
    ...(q.project ? { project: String(q.project) } : {})
  })
})
