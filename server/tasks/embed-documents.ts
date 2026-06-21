import { runEmbedding } from '../services/embedding'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'embed-documents', description: 'Embed documents whose content changed or lack an embedding' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'embed-documents' }, async () => {
      const r = await runEmbedding({ limit: 500 })
      recordJobSummary('embed-documents', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
