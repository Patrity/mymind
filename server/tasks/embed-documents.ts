import { runEmbedding } from '../services/embedding'

export default defineTask({
  meta: { name: 'embed-documents', description: 'Embed documents whose content changed or lack an embedding' },
  async run() {
    const result = await runEmbedding({ limit: 500 })
    return { result }
  }
})
