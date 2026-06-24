import { parseImageConfigInput, saveImageConfig } from '../../lib/imagegen/store'

export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseImageConfigInput(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 422, message: (err as Error).message })
  }
  return await saveImageConfig(input)
})
