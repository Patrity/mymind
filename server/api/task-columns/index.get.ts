import { listColumns } from '../../services/task-columns'

export default defineEventHandler(async () => {
  return listColumns()
})
