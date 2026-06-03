import { runMemoryEnrichment } from '../services/memory-enrich'

export default defineTask({
  meta: { name: 'enrich-memories', description: 'Extract durable memories from sessions via LLM and store them' },
  async run() {
    const result = await runMemoryEnrichment({ limit: 10 })
    return { result }
  }
})
