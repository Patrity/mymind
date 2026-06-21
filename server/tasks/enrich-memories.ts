import { runMemoryEnrichment } from '../services/memory-enrich'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions via LLM and store them' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-memories' }, async () => {
      const r = await runMemoryEnrichment({ limit: 10 })
      recordJobSummary('enrich-memories', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
