import { runMemoryEnrichment } from '../services/memory-enrich'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions via LLM and store them' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-memories' }, async () => {
      const r = await runMemoryEnrichment({ limit: 10 })
      recordEvent({ kind: 'job', name: 'enrich-memories:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
