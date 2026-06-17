import { getSessionMessages } from '../../../services/sessions'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const since = getQuery(event).since as string | undefined
  return getSessionMessages(id, { since })
})
