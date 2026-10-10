// server/tasks/reflect-threads.ts
//
// Cron wrapper for the per-thread self-improvement pass (spec §4.1). The mode check happens
// HERE, before withSpan opens — runThreadPass() also short-circuits on 'off', but checking first
// means an 'off' tick never opens a span or touches the DB at all (matches summarize-threads.ts's
// shape, following server/tasks/summarize-threads.ts).
import { runThreadPass } from '@mymind/core/lib/agent/reflect/thread-pass'
import { getSelfImprovementMode } from '@mymind/core/lib/agent/self-improvement-mode'
import { withSpan, recordJobSummary } from '@mymind/core/lib/observability/record'

export default defineTask({
  meta: { name: 'reflect-threads', description: 'Per-thread self-improvement reflection pass (cycle 76)' },
  async run(): Promise<{ result: Record<string, unknown> }> {
    if (await getSelfImprovementMode() === 'off') return { result: { threads: 0, proposals: 0 } }
    const result = await withSpan({ kind: 'job', name: 'reflect-threads' }, async () => {
      const r = await runThreadPass()
      recordJobSummary('reflect-threads', r)
      return r
    })
    return { result }
  }
})
