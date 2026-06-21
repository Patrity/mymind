import { runEnrichInput } from '../services/enrichment'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'enrich-input', description: 'Propose frontmatter for /input/* docs with sparse metadata' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'enrich-input' }, async () => {
      const r = await runEnrichInput({ limit: 20 })
      recordJobSummary('enrich-input', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
