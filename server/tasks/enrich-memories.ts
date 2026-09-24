import { runMemoryEnrichment, enrichConversations } from '../services/memory-enrich'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions and conversations via LLM and store them' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-memories' }, async () => {
      const r = await runMemoryEnrichment({ limit: 10 })
      const conversationResult = await enrichConversations({ limit: 10 })
      // sweepMemoryConcerns() is DELIBERATELY not called from this cron. It files review_queue
      // rows of kind 'contradiction', 'resident-promotion' and 'stale', but server/api/review/
      // kinds.ts only has approve/reject handlers for 'enrichment', 'memory-supersede',
      // 'memory-contradict' and 'triage' — approving one of the three concern kinds 400s
      // ("Unknown review kind"), and app/pages/review.vue has no card for them either. Wiring
      // this back in without first building those handlers + a /review card just re-files rows
      // nobody can ever resolve, every 15 minutes, forever (that is what happened before this
      // fix — see the whole-branch review that caught it). The function itself, its tests, and
      // its exports are intentionally left intact — this is ONLY the cron wiring, gated off
      // until the review UI catches up. Do not restore this call without building that UI.
      const combined = { ...r, ...conversationResult }
      recordJobSummary('enrich-memories', combined as unknown as Record<string, unknown>)
      return combined
    })
    return { result }
  }
})
