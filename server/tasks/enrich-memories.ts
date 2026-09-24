import { runMemoryEnrichment, enrichConversations } from '../services/memory-enrich'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions and conversations via LLM and store them' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-memories' }, async () => {
      const r = await runMemoryEnrichment({ limit: 10 })
      const conversationResult = await enrichConversations({ limit: 10 })
      const combined = { ...r, ...conversationResult }
      recordJobSummary('enrich-memories', combined as unknown as Record<string, unknown>)
      return combined
    })
    return { result }
  }
})
