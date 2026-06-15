import { runEmbedding } from '../services/embedding'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'embed-documents', description: 'Embed documents whose content changed or lack an embedding' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'embed-documents' }, async () => {
      const r = await runEmbedding({ limit: 500 })
      recordEvent({ kind: 'job', name: 'embed-documents:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
