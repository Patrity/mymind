import { startRecorderFlushLoop } from '../lib/observability/record'

export default defineNitroPlugin(() => {
  startRecorderFlushLoop()
})
