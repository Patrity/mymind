import { summarizeIdleThreads } from '../lib/agent/runtime/summarize'
import { runtimeEnabled } from '../lib/agent/runtime/flag'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-threads', description: 'Fold idle side threads into their running summary (cycle 73)' },
  async run(): Promise<{ result: Record<string, unknown> }> {
    // agent_runtime=false is the legacy path end to end — no runtime-owned background work.
    if (!runtimeEnabled()) return { result: { skipped: 'agent_runtime=false' } }
    const result = await withSpan({ kind: 'job', name: 'summarize-threads' }, async () => {
      const r = await summarizeIdleThreads()
      recordJobSummary('summarize-threads', r)
      return r
    })
    return { result }
  }
})
