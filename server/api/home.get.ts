import { getHome } from '../services/home'
import { isHomeRange } from '../lib/home/range'
import { HOME_RANGE_DEFAULT } from '../../shared/types/home'

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts for all /api/** routes.
  const range = String(getQuery(event).range ?? HOME_RANGE_DEFAULT)
  if (!isHomeRange(range)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown range: ${range}` })
  }
  return await getHome(range)
})
