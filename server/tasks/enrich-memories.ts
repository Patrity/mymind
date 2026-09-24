import { runMemoryEnrichment, enrichConversations } from '../services/memory-enrich'
import { sweepMemoryConcerns } from '../services/memory-concerns'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions and conversations via LLM and store them' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-memories' }, async () => {
      const r = await runMemoryEnrichment({ limit: 10 })
      const conversationResult = await enrichConversations({ limit: 10 })
      // Unscoped: this is the real sweep over the whole store (no `only`). No `scoreDurable` is
      // wired yet, so stale-candidate detection stays inert (staleCandidates: 0) until a durable
      // classifier lands — see server/services/memory-concerns.ts.
      const concerns = await sweepMemoryConcerns()
      const combined = { ...r, ...conversationResult, ...concerns }
      recordJobSummary('enrich-memories', combined as unknown as Record<string, unknown>)
      return combined
    })
    return { result }
  }
})
