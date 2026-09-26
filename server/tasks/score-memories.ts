import { runJevScoring } from '../services/memory-jev'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: {
    name: 'score-memories',
    description: 'Score unreviewed memories with Jev so the review queue surfaces likely junk first'
  },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'score-memories' }, async () => {
      const r = await runJevScoring({ limit: 50 })
      recordJobSummary('score-memories', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
