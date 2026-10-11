import { deleteSecret } from '@mymind/core/lib/exec/secrets'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

export default defineEventHandler(async (event) => {
  const name = getQuery(event).name as string
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name required' })
  await deleteSecret(name)
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('exec-secrets')
  return { ok: true }
})
