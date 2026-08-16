import { sweepUntriaged } from '../services/triage'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'triage-input', description: 'Triage untriaged /input captures (backstop for the immediate path)' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'triage-input' }, async () => {
      const r = await sweepUntriaged({ limit: 20 })
      recordJobSummary('triage-input', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
