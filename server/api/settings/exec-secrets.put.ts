import { z } from 'zod'
import { setSecret } from '@mymind/core/lib/exec/secrets'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

const Body = z.object({ name: z.string().min(1), value: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { name, value } = Body.parse(await readBody(event))
  await setSecret(name, value)
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('exec-secrets')
  return { ok: true }
})
