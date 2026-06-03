import { runEmbedding } from '../../services/embedding'

export default defineEventHandler(async () => runEmbedding({ limit: 500 }))
