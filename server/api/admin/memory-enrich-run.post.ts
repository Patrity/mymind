import { runMemoryEnrichment } from '../../services/memory-enrich'

export default defineEventHandler(async () => runMemoryEnrichment({ limit: 10 }))
