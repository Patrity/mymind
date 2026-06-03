import { runImageOcr } from '../../services/image-ocr'

export default defineEventHandler(async () => runImageOcr({ limit: 20 }))
