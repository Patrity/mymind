import { startRecorderFlushLoop } from '@mymind/core/lib/observability/record'

export default defineNitroPlugin(() => {
  startRecorderFlushLoop()
})
