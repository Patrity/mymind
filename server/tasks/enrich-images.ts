import { runImageEnrich } from '../services/image-enrich'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-images', description: 'Run the image enrichment pipeline on pending/retryable images' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-images' }, async () => {
      const r = await runImageEnrich({ limit: 20 })
      recordEvent({ kind: 'job', name: 'enrich-images:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
