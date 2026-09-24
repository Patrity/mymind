import { listCommands } from '../../services/commands'

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  return listCommands(typeof q === 'string' ? q : undefined)
})
