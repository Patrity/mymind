import { runImageEnrich } from '../../services/image-enrich'

export default defineEventHandler(async () => runImageEnrich({ limit: 20 }))
