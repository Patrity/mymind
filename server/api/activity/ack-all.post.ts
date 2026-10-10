import { ackAllErrors } from '../../services/activity'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async () => {
  await ackAllErrors()
  publishChange({ resource: 'activity', action: 'updated', id: 'all' })
  return { ok: true }
})
