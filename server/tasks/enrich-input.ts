import { runEnrichInput } from '../services/enrichment'

export default defineTask({
  meta: { name: 'enrich-input', description: 'Propose frontmatter for /input/* docs with sparse metadata' },
  async run() {
    const result = await runEnrichInput({ limit: 20 })
    return { result }
  }
})
