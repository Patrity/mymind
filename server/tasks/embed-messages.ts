import { runMessageEmbedding } from '../services/message-embedding'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'embed-messages', description: 'Embed session messages that lack an embedding' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'embed-messages' }, async () => {
      const r = await runMessageEmbedding({ limit: 1000 })
      recordEvent({ kind: 'job', name: 'embed-messages:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
