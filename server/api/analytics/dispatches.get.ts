import { getDispatches, isUsageRange } from '../../services/usage'

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts for all /api/** routes.
  const range = String(getQuery(event).range ?? '30d')
  if (!isUsageRange(range)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown range: ${range}` })
  }
  return await getDispatches(range)
})
