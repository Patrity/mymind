import { runImageOcr } from '../services/image-ocr'

export default defineTask({
  meta: { name: 'ocr-images', description: 'Run vision OCR on images with no ocr_text; populate recommended_tags' },
  async run() {
    const result = await runImageOcr({ limit: 20 })
    return { result }
  }
})
