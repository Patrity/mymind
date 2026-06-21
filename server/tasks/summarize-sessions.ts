import { runSessionSummarize } from '../services/session-summarize'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-sessions', description: 'Generate titles + summaries for new/stale sessions' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'summarize-sessions' }, async () => {
      const r = await runSessionSummarize({})
      recordJobSummary('summarize-sessions', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
