import { runBackfillBatch } from '../services/memory-backfill'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: {
    name: 'memory-backfill',
    description: 'Dual-score backfill (cycle 77): Jev + audit on 40 live memories per run while the switch is running'
  },
  async run(): Promise<{ result: Record<string, unknown> }> {
    const result = await withSpan({ kind: 'job', name: 'memory-backfill' }, async () => {
      const r = await runBackfillBatch()
      recordJobSummary('memory-backfill', r)
      return r
    })
    return { result }
  }
})
