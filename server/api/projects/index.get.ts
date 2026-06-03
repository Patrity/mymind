import { listProjects } from '../../services/projects'

export default defineEventHandler(async (event) => {
  const activeOnly = getQuery(event).active === 'true'
  return listProjects({ activeOnly })
})
