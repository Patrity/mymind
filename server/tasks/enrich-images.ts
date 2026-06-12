import { runImageEnrich } from '../services/image-enrich'

export default defineTask({
  meta: { name: 'enrich-images', description: 'Run the image enrichment pipeline on pending/retryable images' },
  async run() {
    const result = await runImageEnrich({ limit: 20 })
    return { result }
  }
})
