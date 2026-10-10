import { ackActivity } from '../../../services/activity'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await ackActivity(id)
  publishChange({ resource: 'activity', action: 'updated', id })
  return { ok: true }
})
