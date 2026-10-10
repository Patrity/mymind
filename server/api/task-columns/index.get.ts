import { listColumns } from '@mymind/core/services/task-columns'

export default defineEventHandler(async () => {
  return listColumns()
})
