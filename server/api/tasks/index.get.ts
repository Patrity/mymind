import { listTasks } from '../../services/tasks'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return listTasks({
    ...(q.status ? { status: String(q.status) } : {}),
    ...(q.project ? { project: String(q.project) } : {})
  })
})
