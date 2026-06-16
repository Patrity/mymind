import { runSessionSummarize } from '../services/session-summarize'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-sessions', description: 'Generate titles + summaries for new/stale sessions' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'summarize-sessions' }, async () => {
      const r = await runSessionSummarize({})
      recordEvent({ kind: 'job', name: 'summarize-sessions:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
