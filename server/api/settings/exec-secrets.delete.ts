import { deleteSecret } from '../../lib/exec/secrets'

export default defineEventHandler(async (event) => {
  const name = getQuery(event).name as string
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name required' })
  await deleteSecret(name)
  return { ok: true }
})
