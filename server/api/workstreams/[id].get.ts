import { getWorkstream, workstreamDTO } from '@mymind/core/lib/agent/workstreams/store'
import { requireWorkstreamId } from '../../utils/workstreams-http'

export default defineEventHandler(async (event) => {
  const row = await getWorkstream(requireWorkstreamId(event))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'No such workstream', data: { message: 'No such workstream.' } })
  return workstreamDTO(row)
})
