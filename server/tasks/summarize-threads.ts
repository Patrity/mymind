import { summarizeIdleThreads } from '../lib/agent/runtime/summarize'
import { withSpan } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-threads', description: 'Fold idle side threads into their running summary (cycle 73)' },
  async run() {
    const summarized = await withSpan({ kind: 'job', name: 'summarize-threads' }, () => summarizeIdleThreads())
    return { result: { summarized } }
  }
})
