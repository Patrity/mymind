import { loadImageConfig } from '../../lib/imagegen/store'

export default defineEventHandler(async () => {
  return await loadImageConfig()  // no secrets in this config — safe to return whole
})
