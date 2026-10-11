import { parseImageConfigInput, saveImageConfig } from '@mymind/core/lib/imagegen/store'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseImageConfigInput(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 422, message: (err as Error).message })
  }
  const saved = await saveImageConfig(input)
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('imagegen')
  return saved
})
