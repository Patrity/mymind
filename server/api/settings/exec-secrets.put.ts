import { z } from 'zod'
import { setSecret } from '../../lib/exec/secrets'

const Body = z.object({ name: z.string().min(1), value: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { name, value } = Body.parse(await readBody(event))
  await setSecret(name, value)
  return { ok: true }
})
